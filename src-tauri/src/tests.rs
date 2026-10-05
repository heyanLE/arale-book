use crate::{
    annotations, cards, importer, page_text,
    storage::{self, Backend},
};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;

#[test]
fn external_arguments_resolve_relative_paths_spaces_and_literal_flags() {
    let root = tempfile::tempdir().unwrap();
    let book = root.path().join("外部 [书];猫.cbz");
    let flag = root.path().join("-literal.cbz");
    fs::write(&book, b"fixture").unwrap();
    fs::write(&flag, b"fixture").unwrap();
    let args = [
        "app",
        "--ignored",
        "missing.cbz",
        "外部 [书];猫.cbz",
        "外部 [书];猫.cbz",
        "",
        "--",
        "-literal.cbz",
    ];
    let paths = crate::system::argument_paths(args.map(str::to_owned), root.path());
    assert_eq!(paths.len(), 2);
    assert_eq!(
        std::path::Path::new(&paths[0]).canonicalize().unwrap(),
        book.canonicalize().unwrap()
    );
    assert_eq!(
        std::path::Path::new(&paths[1]).canonicalize().unwrap(),
        flag.canonicalize().unwrap()
    );
    let absolute = crate::system::argument_paths(
        ["app".into(), book.to_string_lossy().into_owned()],
        &root.path().join("different-cwd"),
    );
    assert_eq!(absolute, vec![paths[0].clone()]);
}

#[test]
fn reveal_uses_library_id_and_ignores_untrusted_metadata_directory() {
    let (_root, mut backend, book) = setup();
    let id = book["id"].as_str().unwrap();
    backend.books[0]["dir"] = json!("C:/");
    assert_eq!(
        crate::system::reveal_target(&backend, id)
            .unwrap()
            .canonicalize()
            .unwrap(),
        backend.dir(id).unwrap().canonicalize().unwrap()
    );
    for invalid in ["..", "../library", "unknown_book"] {
        assert!(crate::system::reveal_target(&backend, invalid).is_err());
    }
    fs::rename(backend.dir(id).unwrap(), backend.root.join("unavailable")).unwrap();
    assert!(crate::system::reveal_target(&backend, id).is_err());
}

#[cfg(windows)]
#[test]
fn atomic_json_replace_retries_temporary_lock_and_preserves_old_data_on_denial() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("checkpoint.json");
    storage::write(&path, &json!({"version":1})).unwrap();
    let handle = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(70));
        drop(handle);
    });
    storage::write(&path, &json!({"version":2})).unwrap();
    release.join().unwrap();
    let persistent = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    assert!(storage::write(&path, &json!({"version":3})).is_err());
    assert_eq!(
        storage::read(&path, Value::Null).unwrap(),
        json!({"version":2})
    );
    drop(persistent);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn directory_publication_waits_for_temporary_windows_file_lock() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("staged");
    let target = root.path().join("published");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("marker"), b"original").unwrap();
    let handle = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(source.join("marker"))
        .unwrap();
    assert!(fs::rename(&source, &target).is_err());
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(70));
        drop(handle);
    });
    storage::rename_directory(&source, &target).unwrap();
    release.join().unwrap();
    assert_eq!(fs::read(target.join("marker")).unwrap(), b"original");
    assert!(!source.exists());
}

fn setup() -> (tempfile::TempDir, Backend, Value) {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("漫画");
    fs::create_dir(&source).unwrap();
    image::RgbImage::new(100, 120)
        .save(source.join("p10.png"))
        .unwrap();
    image::RgbImage::new(100, 120)
        .save(source.join("p2.png"))
        .unwrap();
    storage::write(&source.join("manga.json"), &json!({"pages":[{"url":"p2.png","blocks":[{"box":[1,2,30,40],"font_size":12,"lines":["猫です。"],"single_line":true}]}]})).unwrap();
    let mut backend = Backend::load(dir.path().join("userdata")).unwrap();
    let book = importer::import(&mut backend, &source).unwrap();
    (dir, backend, book)
}
fn document(book: &Value) -> Value {
    let url = book["pages"][0]["url"].as_str().unwrap();
    let mut pages = serde_json::Map::new();
    pages.insert(url.into(), json!({"width":100,"height":120,"signature":""}));
    let mut objects = serde_json::Map::new();
    objects.insert(url.into(),json!([{"id":"stroke","kind":"stroke","color":"#ff0000","width":4,"opacity":1,"points":[{"x":1,"y":2},{"x":80,"y":100}]}]));
    json!({"version":1,"revision":0,"visible":true,"pages":pages,"layers":[{"id":"pen","type":"pen","name":"画笔","visible":true,"locked":false,"objects":objects}]})
}

fn dictionary_zip(path: &std::path::Path, entries: &[(&str, &str)]) {
    let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name, text) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(text.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
}

fn epub_prepared(href: &str) -> Value {
    json!({"parsed":{"title":"EPUB 测试","author":"作者","language":"ja","publisher":null,"description":null,"coverRel":null,"opfRel":"OPS/book.opf","spine":[{"idref":"one","href":href,"linear":true}],"toc":[{"label":"第一章","href":href,"depth":0}],"direction":"rtl"},
        "documents":[{"href":href,"html":"<html><body>😀猫</body></html>","plainText":"😀猫"}],"imagePages":[]})
}
#[test]
fn epub_import_publishes_complete_books_and_checks_source_and_resource_boundaries() {
    let (temp, mut backend, _) = setup();
    let source = temp.path().join("测试.epub");
    dictionary_zip(
        &source,
        &[
            ("OPS/book.opf", "<package/>"),
            ("OPS/正文%2525.xhtml", "<p>😀猫</p>"),
            ("OPS/main.css", "p{color:red}"),
            ("OPS/evil.js", "alert(1)"),
        ],
    );
    let staged = crate::epub::stage(&backend, &source).unwrap();
    let id = staged["id"].as_str().unwrap();
    assert!(backend.book(id).is_err());
    assert_eq!(staged["entries"][1]["name"], "OPS/正文%25.xhtml");
    assert!(crate::epub::staged_text(&backend, id, "../../positions.json").is_err());
    assert!(crate::epub::commit(&mut backend, id, &json!({})).is_err());
    assert!(backend.book(id).is_err());
    let book = crate::epub::commit(&mut backend, id, &epub_prepared("OPS/正文%25.xhtml")).unwrap();
    assert_eq!(book["format"], "epub");
    assert_eq!(book["readerMode"], "epub");
    assert!(source.is_file());
    assert!(!backend.root.join("epub-imports").join(id).exists());
    let chapter = crate::epub::chapter(&backend, id, 99).unwrap();
    assert_eq!(chapter["spineIndex"], 0);
    assert_eq!(chapter["plainText"], "😀猫");
    assert!(chapter["url"].as_str().unwrap().contains("%2525.xhtml"));
    assert!(crate::epub::resource(&backend, id, "OPS/正文%25.xhtml")
        .unwrap()
        .1
        .starts_with("text/html"));
    assert_eq!(
        crate::epub::resource(&backend, id, "OPS/main.css")
            .unwrap()
            .0,
        b"p{color:red}"
    );
    assert!(crate::epub::resource(&backend, id, "OPS/evil.js").is_err());
    assert!(crate::epub::resource(&backend, id, "../../positions.json").is_err());
    let csp = crate::epub::csp();
    assert!(csp.contains("script-src 'sha256-"));
    assert!(!csp
        .split("script-src ")
        .nth(1)
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .contains("unsafe-inline"));
    let input = crate::segments::input(&backend, id).unwrap();
    assert_eq!(
        input["units"][0],
        json!({"ref":"chapter:0:OPS/正文%25.xhtml","text":"😀猫","label":"第一章"})
    );
    let artifact = json!({"bookId":id,"engine":"kuromoji-morph-v1","vocabulary":[],"units":[{"ref":input["units"][0]["ref"],"text":"😀猫","tokens":[{"start":2,"end":3,"surface":"猫"}]}]});
    crate::segments::commit(
        &backend,
        id,
        &artifact.to_string(),
        input["fingerprint"].as_str().unwrap(),
    )
    .unwrap();
    let reopened = Backend::load(backend.root.clone()).unwrap();
    assert_eq!(
        crate::epub::chapter(&reopened, id, 0).unwrap()["plainText"],
        "😀猫"
    );
    fs::write(
        backend.dir(id).unwrap().join("content/OPS/正文%25.xhtml"),
        "changed",
    )
    .unwrap();
    assert!(crate::epub::chapter(&backend, id, 0).is_err());
    assert!(crate::segments::commit(
        &backend,
        id,
        &artifact.to_string(),
        input["fingerprint"].as_str().unwrap()
    )
    .is_err());
    assert!(crate::segments::read(&backend, id).unwrap().is_object());
}
#[test]
fn epub_rejects_encoded_traversal_and_duplicate_names_and_cleans_pending_imports() {
    let (temp, backend, _) = setup();
    for entries in [
        vec![
            ("OPS/book.opf", "<package/>"),
            ("OPS/%2e%2e/%2e%2e/escape.txt", "bad"),
        ],
        vec![("OPS/book.opf", "one"), ("OPS/./book.opf", "two")],
    ] {
        let source = temp.path().join("invalid.epub");
        dictionary_zip(&source, &entries);
        assert!(crate::epub::stage(&backend, &source).is_err());
        assert_eq!(
            fs::read_dir(backend.root.join("epub-imports"))
                .unwrap()
                .count(),
            0
        );
        assert!(!backend.root.join("escape.txt").exists());
    }
    let source = temp.path().join("pending.epub");
    dictionary_zip(&source, &[("OPS/book.opf", "<package/>")]);
    let staged = crate::epub::stage(&backend, &source).unwrap();
    fs::write(backend.root.join("epub-imports/keep.txt"), "unrelated").unwrap();
    crate::epub::clean_pending(&backend).unwrap();
    assert!(backend.root.join("epub-imports/keep.txt").is_file());
    assert!(!backend
        .root
        .join("epub-imports")
        .join(staged["id"].as_str().unwrap())
        .exists());
}
#[test]
fn epub_failed_index_publication_does_not_leave_a_recoverable_orphan_book() {
    let (temp, mut backend, _) = setup();
    let source = temp.path().join("failure.epub");
    dictionary_zip(
        &source,
        &[
            ("OPS/book.opf", "<package/>"),
            ("OPS/one.xhtml", "<p>猫</p>"),
        ],
    );
    let staged = crate::epub::stage(&backend, &source).unwrap();
    let id = staged["id"].as_str().unwrap();
    let index = backend.root.join("library/index.json");
    fs::remove_file(&index).unwrap();
    fs::create_dir(&index).unwrap(); // Force atomic persist to fail inside this test's temporary root.
    assert!(crate::epub::commit(&mut backend, id, &epub_prepared("OPS/one.xhtml")).is_err());
    assert!(backend.book(id).is_err());
    assert!(!backend.dir(id).unwrap().exists());
    assert!(backend.root.join("epub-imports").join(id).is_dir());
}
#[test]
fn dictionary_import_is_atomic_compatible_and_excludes_archive_paths() {
    let (temp, backend, _) = setup();
    let source = temp.path().join("测试词典.zip");
    dictionary_zip(
        &source,
        &[
            ("wrapper/index.json", r#"{"title":"测试词典","format":3}"#),
            ("wrapper/term_bank_1.json", "[]"),
            ("wrapper/media/huge.png", "not extracted"),
            ("wrapper/../../escape.json", "not extracted"),
        ],
    );
    let staged = crate::dictionaries::stage(&backend, &source).unwrap();
    let id = staged["id"].as_str().unwrap();
    assert!(crate::dictionaries::list(&backend).unwrap().is_empty());
    assert!(crate::dictionaries::raw_bank(&backend, id, "../../escape.json").is_err());
    assert!(crate::dictionaries::commit(&backend, id, "{}", "[]").is_err());
    assert!(crate::dictionaries::list(&backend).unwrap().is_empty());
    let terms = r#"[{"expression":"猫","reading":"ねこ","glossary":["猫"],"dictionaryId":"spoofed","dictionaryTitle":"spoofed"}]"#;
    let info = crate::dictionaries::commit(&backend, id, terms, "[]").unwrap();
    assert_eq!(info["termCount"], 1);
    let data = crate::dictionaries::data(&backend, id).unwrap();
    let terms: Value = serde_json::from_str(data["terms"].as_str().unwrap()).unwrap();
    assert_eq!(terms[0]["dictionaryId"], id);
    assert_eq!(terms[0]["dictionaryTitle"], "测试词典");
    assert!(!backend
        .root
        .join("dictionaries")
        .join(id)
        .join("media")
        .exists());
    assert!(source.is_file());
    let reopened = Backend::load(backend.root.clone()).unwrap();
    assert_eq!(crate::dictionaries::list(&reopened).unwrap().len(), 1);
    assert_eq!(
        crate::dictionaries::enabled(&backend, id, false).unwrap()["termCount"],
        0
    );
    assert!(crate::dictionaries::remove(&backend, "../library").is_err());
    assert!(
        crate::dictionaries::remove(&backend, id).unwrap()["dictionaries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn frequency_only_and_invalid_dictionaries_do_not_publish_partial_imports() {
    let (temp, backend, _) = setup();
    let source = temp.path().join("freq.zip");
    dictionary_zip(
        &source,
        &[
            ("index.json", r#"{"title":"频率"}"#),
            ("term_meta_bank_1.json", "[]"),
        ],
    );
    let staged = crate::dictionaries::stage(&backend, &source).unwrap();
    let id = staged["id"].as_str().unwrap();
    let info = crate::dictionaries::commit(&backend, id, "[]", r#"[{"expression":"猫","reading":"","frequencies":[{"value":1,"display":null,"dictionary":"频率"}]}]"#).unwrap();
    assert_eq!(info["termCount"], 0);
    assert_eq!(info["freqCount"], 1);
    let unfinished = crate::dictionaries::stage(&backend, &source).unwrap();
    let pending = backend.root.join("dictionaries/.imports");
    fs::write(pending.join("unrelated.txt"), "preserve").unwrap();
    crate::dictionaries::clean_pending(&backend).unwrap();
    assert!(!pending.join(unfinished["id"].as_str().unwrap()).exists());
    assert!(pending.join("unrelated.txt").is_file());
    dictionary_zip(&source, &[("index.json", "{}"), ("unrelated.json", "[]")]);
    assert!(crate::dictionaries::stage(&backend, &source).is_err());
    assert_eq!(crate::dictionaries::list(&backend).unwrap().len(), 1);
}
#[test]
fn segments_validate_utf16_and_source_fingerprint_and_persist_existing_schema() {
    let (_temp, backend, book) = setup();
    let id = book["id"].as_str().unwrap();
    let content = backend.dir(id).unwrap().join("content/manga.json");
    let mut manga = storage::read(&content, Value::Null).unwrap();
    manga["pages"][0]["blocks"][0]["lines"] = json!(["😀猫です。"]);
    storage::write(&content, &manga).unwrap();
    let input = crate::segments::input(&backend, id).unwrap();
    let fingerprint = input["fingerprint"].as_str().unwrap();
    let mut unit = input["units"][0].clone();
    unit["tokens"] = json!([{"surface":"猫","start":2,"end":3,"matched":true,"baseForm":"猫"}]);
    let mut artifact = json!({"bookId":id,"engine":"kuromoji-morph-v1","dictionarySignature":"","dictionaryCount":0,"units":[unit],"vocabulary":[]});
    assert!(crate::segments::commit(&backend, id, &artifact.to_string(), "stale").is_err());
    artifact["units"][0]["tokens"][0]["start"] = json!(1);
    assert!(crate::segments::commit(&backend, id, &artifact.to_string(), fingerprint).is_err());
    artifact["units"][0]["tokens"][0]["start"] = json!(2);
    crate::segments::commit(&backend, id, &artifact.to_string(), fingerprint).unwrap();
    assert!(
        crate::segments::read(&Backend::load(backend.root.clone()).unwrap(), id).unwrap()
            ["generatedAt"]
            .as_u64()
            .unwrap()
            > 0
    );
    manga["pages"][0]["blocks"][0]["lines"] = json!(["変わりました"]);
    storage::write(&content, &manga).unwrap();
    assert!(crate::segments::commit(&backend, id, &artifact.to_string(), fingerprint).is_err());
    assert_eq!(
        crate::segments::read(&backend, id).unwrap()["units"][0]["text"],
        "😀猫です。"
    );
    crate::segments::clear(&backend, id).unwrap();
    assert!(crate::segments::read(&backend, id).unwrap().is_null());
    fs::write(backend.dir(id).unwrap().join("segments.json"), "{bad").unwrap();
    assert!(crate::segments::read(&backend, id).unwrap().is_null());
}
#[test]
fn import_preserves_source_and_reopens_existing_schema() {
    let (dir, backend, book) = setup();
    let id = book["id"].as_str().unwrap();
    assert!(dir.path().join("漫画/p2.png").is_file());
    assert_eq!(book["pages"].as_array().unwrap().len(), 2);
    assert_eq!(
        page_text(&backend, id, 0).unwrap()["blocks"][0]["lines"][0],
        "猫です。"
    );
    assert_eq!(
        page_text(&backend, id, 0).unwrap()["blocks"][0]["singleLine"],
        true
    );
    let reopened = Backend::load(backend.root.clone()).unwrap();
    assert_eq!(reopened.books, backend.books);
}
#[test]
fn invalid_import_does_not_leave_partial_book_or_change_index() {
    let (dir, mut backend, _) = setup();
    let before = backend.books.clone();
    let bad = dir.path().join("broken.cbz");
    fs::write(&bad, b"not a zip").unwrap();
    assert!(importer::import(&mut backend, &bad).is_err());
    assert_eq!(backend.books, before);
    assert_eq!(
        fs::read_dir(backend.root.join("library"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().unwrap().is_dir())
            .count(),
        1
    );
}
#[test]
fn library_filters_and_metadata_preserve_structural_fields() {
    let (_dir, mut backend, book) = setup();
    let id = book["id"].as_str().unwrap();
    let changed = backend
        .update(
            id,
            &json!({"title":"新标题","tags":["N3"],"id":"evil","dir":"C:/", "pages":[]}),
        )
        .unwrap();
    assert_eq!(changed["id"], id);
    assert_eq!(changed["pages"], book["pages"]);
    assert_eq!(changed["dir"], book["dir"]);
    assert_eq!(
        backend.list(&json!({"search":"新标题","tags":["N3"]}))["total"],
        1
    );
    assert_eq!(backend.list(&json!({"format":"epub"}))["total"], 0);
}
#[test]
fn cards_deduplicate_preserve_user_notes_and_source() {
    let (_dir, backend, book) = setup();
    let id = book["id"].as_str().unwrap();
    let draft = json!({"word":"猫","context":"猫です。","dictionaryExpression":"猫","source":{"kind":"comic","pageIndex":0,"pageUrl":book["pages"][0]["url"]}});
    let card = cards::mutate(&backend, id, "cards:add", &[json!(id), draft.clone()]).unwrap();
    cards::mutate(
        &backend,
        id,
        "cards:update",
        &[
            json!(id),
            card["id"].clone(),
            json!({"note":"笔记","id":"evil"}),
        ],
    )
    .unwrap();
    let second = cards::mutate(&backend, id, "cards:add", &[json!(id), draft]).unwrap();
    assert_eq!(second["id"], card["id"]);
    assert_eq!(second["note"], "笔记");
    assert!(second["source"]["pageUrl"].is_string());
    assert_eq!(cards::list(&backend, id).unwrap().len(), 1);
}
#[test]
fn annotation_revision_conflict_and_stale_original_are_preserved() {
    let (_dir, backend, book) = setup();
    let id = book["id"].as_str().unwrap();
    let original = document(&book);
    let saved = annotations::write(&backend, id, original.clone()).unwrap();
    assert_eq!(saved["document"]["revision"], 1);
    assert_eq!(
        saved["document"]["pages"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()["signature"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert!(annotations::write(&backend, id, original).is_err());
    let page = backend
        .dir(id)
        .unwrap()
        .join("content")
        .join(book["pages"][0]["url"].as_str().unwrap());
    fs::write(&page, b"changed").unwrap();
    assert_eq!(
        annotations::read(&backend, id).unwrap()["stalePages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut changed = saved["document"].clone();
    let url = book["pages"][0]["url"].as_str().unwrap();
    changed["layers"][0]["objects"][url][0]["points"][0]["x"] = json!(20);
    assert!(annotations::write(&backend, id, changed).is_err());
    let mut cleared = saved["document"].clone();
    cleared["layers"] = json!([]);
    cleared["pages"] = json!({});
    assert!(
        annotations::write(&backend, id, cleared).unwrap()["stalePages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn annotation_rejects_invalid_type_and_coordinates() {
    let (_dir, _backend, book) = setup();
    let mut doc = document(&book);
    let url = book["pages"][0]["url"].as_str().unwrap();
    doc["layers"][0]["objects"][url][0]["points"][0]["x"] = json!(101);
    assert!(annotations::validate(&doc).is_err());
    doc = document(&book);
    doc["layers"][0]["type"] = json!("text");
    assert!(annotations::validate(&doc).is_err());
}
#[test]
fn path_and_atomic_io_errors_do_not_overwrite_user_data() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("safe.txt"), b"safe").unwrap();
    for path in [
        "../safe.txt",
        "..\\safe.txt",
        "C:/safe.txt",
        "/safe.txt",
        "safe.txt:stream",
    ] {
        assert!(storage::inside(dir.path(), path).is_err());
    }
    assert!(storage::inside(dir.path(), "safe.txt").unwrap().is_file());
    assert!(storage::valid_id("../book").is_err());
    let corrupt = dir.path().join("cards.json");
    fs::write(&corrupt, b"{broken").unwrap();
    assert!(storage::read(&corrupt, json!({})).is_err());
    assert_eq!(fs::read(corrupt).unwrap(), b"{broken");
    let path = dir.path().join("data.json");
    storage::write(&path, &json!({"value":1})).unwrap();
    storage::write(&path, &json!({"value":2})).unwrap();
    assert_eq!(storage::read(&path, Value::Null).unwrap()["value"], 2);
}
