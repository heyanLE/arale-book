use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufWriter, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn id() -> String {
    format!("bk_{}", &uuid::Uuid::new_v4().simple().to_string()[..16])
}

pub fn read(path: &Path, fallback: Value) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("JSON 损坏，原文件已保留：{}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(error) => Err(error).with_context(|| format!("无法读取 {}", path.display())),
    }
}

pub fn write(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("没有父目录")?;
    fs::create_dir_all(parent)?;
    // NamedTempFile::persist uses an atomic replace on Windows as well as Unix.
    // A failed write never removes the previous destination.
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    {
        // serde emits many tiny writes. Buffer them before reaching the OS, especially
        // for large frequency dictionaries; preserve the same atomic replace/sync contract.
        let mut writer = BufWriter::new(temporary.as_file_mut());
        serde_json::to_writer(&mut writer, value)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    temporary.as_file().sync_all()?;
    // A reader, indexer, or scanner may briefly hold the destination without
    // FILE_SHARE_DELETE. Retry atomic replace itself, retaining the same temporary
    // file and the old destination. Persistent denial must still surface as an error.
    #[cfg(windows)]
    for delay in [25, 50, 100, 200, 400] {
        match temporary.persist(path) {
            Ok(_) => return Ok(()),
            Err(error) if matches!(error.error.raw_os_error(), Some(5 | 32 | 33)) => {
                temporary = error.file;
                std::thread::sleep(std::time::Duration::from_millis(delay));
            }
            Err(error) => {
                return Err(error.error).with_context(|| format!("无法原子替换 {}", path.display()))
            }
        }
    }
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("无法原子替换 {}", path.display()))?;
    Ok(())
}

pub fn valid_id(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        bail!("无效的数据 ID");
    }
    Ok(value)
}

pub fn rename_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    // Windows indexers/scanners can briefly deny directory renames after new files close.
    // Retry the same operation only; never delete a destination to make it succeed.
    #[cfg(windows)]
    for delay in [25, 50, 100, 200, 400] {
        match fs::rename(source, target) {
            Ok(()) => return Ok(()),
            Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) => {
                std::thread::sleep(std::time::Duration::from_millis(delay))
            }
            Err(error) => return Err(error),
        }
    }
    fs::rename(source, target)
}

pub fn inside(root: &Path, relative: &str) -> Result<PathBuf> {
    let rel = relative.replace('\\', "/");
    if rel.is_empty()
        || rel.contains('\0')
        || rel.contains(':')
        || rel.starts_with('/')
        || rel.split('/').any(|c| c == "..")
    {
        bail!("路径越界");
    }
    let path = Path::new(&rel);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        bail!("路径越界");
    }
    let root = root.canonicalize()?;
    let target = root.join(path).canonicalize()?;
    if !target.starts_with(&root) || target == root {
        bail!("路径越界");
    }
    Ok(target)
}

pub struct Backend {
    pub root: PathBuf,
    pub books: Vec<Value>,
}

impl Backend {
    pub fn load(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("library"))?;
        let index = read(
            &root.join("library/index.json"),
            json!({"version":1,"books":[]}),
        )?;
        let mut books = index["books"]
            .as_array()
            .context("书库索引格式错误，原文件已保留")?
            .clone();
        if books.is_empty() {
            for entry in fs::read_dir(root.join("library"))? {
                let entry = entry?;
                if entry.file_type()?.is_dir() && entry.path().join("book.json").is_file() {
                    books.push(read(&entry.path().join("book.json"), Value::Null)?);
                }
            }
        }
        for book in &books {
            valid_id(book["id"].as_str().context("书库记录缺少 ID")?)?;
        }
        Ok(Self { root, books })
    }
    pub fn dir(&self, id: &str) -> Result<PathBuf> {
        Ok(self.root.join("library").join(valid_id(id)?))
    }
    pub fn book(&self, id: &str) -> Result<&Value> {
        valid_id(id)?;
        self.books
            .iter()
            .find(|book| book["id"] == id)
            .context("书不存在（可能已删除）")
    }
    pub fn persist_books(&self, next: &[Value]) -> Result<()> {
        write(
            &self.root.join("library/index.json"),
            &json!({"version":1,"books":next}),
        )
    }
    pub fn add(&mut self, book: Value) -> Result<Value> {
        let id = book["id"].as_str().context("书缺少 ID")?;
        write(&self.dir(id)?.join("book.json"), &book)?;
        let mut next = self.books.clone();
        next.push(book.clone());
        self.persist_books(&next)?;
        self.books = next;
        Ok(book)
    }
    pub fn update(&mut self, id: &str, patch: &Value) -> Result<Value> {
        let mut updated = self.book(id)?.clone();
        let target = updated.as_object_mut().context("书记录格式错误")?;
        for key in [
            "title",
            "author",
            "series",
            "volume",
            "tags",
            "direction",
            "lastOpenedAt",
        ] {
            if let Some(value) = patch.get(key) {
                let valid = match key {
                    "title" | "author" => value.is_string(),
                    "series" => value.is_string() || value.is_null(),
                    "volume" => value.is_number() || value.is_null(),
                    "tags" => value
                        .as_array()
                        .is_some_and(|rows| rows.iter().all(Value::is_string)),
                    "direction" => value == "ltr" || value == "rtl",
                    "lastOpenedAt" => value.is_u64(),
                    _ => false,
                };
                if !valid {
                    bail!("书籍字段格式错误：{key}");
                }
                target.insert(key.into(), value.clone());
                if key == "title" {
                    target.insert(
                        "titleSort".into(),
                        json!(value.as_str().unwrap().to_lowercase()),
                    );
                }
            }
        }
        target.insert("updatedAt".into(), json!(now()));
        write(&self.dir(id)?.join("book.json"), &updated)?;
        let mut next = self.books.clone();
        *next.iter_mut().find(|book| book["id"] == id).unwrap() = updated.clone();
        self.persist_books(&next)?;
        self.books = next;
        Ok(updated)
    }
    pub fn list(&self, query: &Value) -> Value {
        let unique = |key: &str| {
            let mut values = Vec::<String>::new();
            for book in &self.books {
                if key == "tags" {
                    values.extend(
                        book[key]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_owned),
                    );
                } else if let Some(text) = book[key].as_str().filter(|s| !s.is_empty()) {
                    values.push(text.to_owned());
                }
            }
            values.sort();
            values.dedup();
            values
        };
        let needle = query["search"].as_str().unwrap_or("").trim().to_lowercase();
        let mut books: Vec<_> = self
            .books
            .iter()
            .filter(|book| {
                if query["format"].is_string() && query["format"] != book["format"] {
                    return false;
                }
                if let Some(tags) = query["tags"].as_array().filter(|t| !t.is_empty()) {
                    if !tags
                        .iter()
                        .any(|t| book["tags"].as_array().is_some_and(|bt| bt.contains(t)))
                    {
                        return false;
                    }
                }
                needle.is_empty()
                    || ["title", "author", "series", "publisher", "tags"]
                        .iter()
                        .any(|k| book[k].to_string().to_lowercase().contains(&needle))
            })
            .cloned()
            .collect();
        let sort = query["sort"].as_str().unwrap_or("title");
        books.sort_by(|a, b| {
            let text = |key: &str| {
                a[key]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b[key].as_str().unwrap_or(""))
            };
            let number = |key: &str| {
                a[key]
                    .as_u64()
                    .unwrap_or(0)
                    .cmp(&b[key].as_u64().unwrap_or(0))
            };
            let order = match sort {
                "author" => text("author").then_with(|| text("titleSort")),
                "series" => text("series")
                    .then_with(|| {
                        a["volume"]
                            .as_f64()
                            .unwrap_or(0.0)
                            .total_cmp(&b["volume"].as_f64().unwrap_or(0.0))
                    })
                    .then_with(|| text("titleSort")),
                "added" | "addedDesc" => number("addedAt"),
                "lastOpened" => number("lastOpenedAt").reverse(),
                _ => text("titleSort"),
            };
            if sort == "titleDesc" || sort == "addedDesc" {
                order.reverse()
            } else {
                order
            }
        });
        let total = books.len();
        let offset = query["offset"].as_u64().unwrap_or(0) as usize;
        let limit = query["limit"]
            .as_u64()
            .filter(|l| *l > 0)
            .unwrap_or(total as u64) as usize;
        json!({"books": books.into_iter().skip(offset).take(limit).collect::<Vec<_>>(), "total":total,
            "allTags":unique("tags"), "allSeries":unique("series"), "allAuthors":unique("author")})
    }
}
