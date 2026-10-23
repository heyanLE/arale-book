use super::*;
impl Remote {
    pub async fn ensure_asset(
        &self,
        backend: &Mutex<Backend>,
        id: &str,
        relative: &str,
    ) -> Result<()> {
        self.asset(backend, id, relative, None).await
    }
    async fn asset(
        &self,
        backend: &Mutex<Backend>,
        id: &str,
        relative: &str,
        epoch: Option<u64>,
    ) -> Result<()> {
        if !id.starts_with("rs_") {
            return Ok(());
        }
        let mut book = self.snapshot(backend, id)?;
        let revision = relative
            .split('/')
            .next()
            .filter(|r| digest(r))
            .context("无效页图版本")?;
        if revision != book["remote"]["revision"] {
            book = storage::read(
                &self
                    .dir(id)?
                    .join("manifests")
                    .join(format!("{revision}.json")),
                Value::Null,
            )?;
        }
        let page = book["pages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["url"] == relative)
            .or_else(|| {
                (book["remote"]["coverPage"]["url"] == relative)
                    .then_some(&book["remote"]["coverPage"])
            })
            .context("资源不在远程页面清单中")?
            .clone();
        let dir = self.dir(id)?.join("content");
        let target = dir.join(relative);
        if target.is_file() {
            storage::inside(&dir, relative)?;
            return Ok(());
        }
        let key = format!("{id}/{relative}");
        let gate = {
            let mut locks = self.asset_locks.lock().unwrap();
            // Retain only in-flight requests; no unbounded per-page lock cache.
            locks.retain(|_, gate| Arc::strong_count(gate) > 1);
            locks
                .entry(key)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let reading = self.active_book.lock().unwrap().as_deref() == Some(id);
        let _slot = if epoch.is_some() {
            self.prefetch_slots.acquire().await?
        } else if reading {
            self.asset_slots.acquire().await?
        } else {
            self.cover_slots.acquire().await?
        };
        if epoch.is_some_and(|e| self.prefetch_epochs.lock().unwrap().get(id) != Some(&e)) {
            return Ok(());
        }
        // A queued cover/prefetch must not hold the per-page lock ahead of a reader.
        let _same = gate.lock().await;
        if target.is_file() {
            storage::inside(&dir, relative)?;
            return Ok(());
        }
        if epoch.is_some_and(|e| self.prefetch_epochs.lock().unwrap().get(id) != Some(&e)) {
            return Ok(());
        }
        let c = self.connection(text(&book["remote"], "connectionId")?)?;
        let (_, bytes) = self
            .request(
                &c,
                Method::GET,
                &format!(
                    "api/v1/books/{}/pages/{}?revision={revision}",
                    text(&book["remote"], "bookId")?,
                    text(&page, "id")?
                ),
                None,
                64 * 1024 * 1024,
            )
            .await?;
        if bytes.len() as u64 != page["bytes"].as_u64().context("缺少页面大小")?
            || format!("{:x}", Sha256::digest(&bytes)) != text(&page, "sha256")?
        {
            bail!("页面校验失败，缓存未写入");
        }
        fs::create_dir_all(target.parent().unwrap())?;
        if !target
            .parent()
            .unwrap()
            .canonicalize()?
            .starts_with(self.dir(id)?.canonicalize()?)
        {
            bail!("缓存目录越界");
        }
        use std::io::Write;
        let mut temp = tempfile::NamedTempFile::new_in(target.parent().unwrap())?;
        temp.write_all(&bytes)?;
        temp.as_file().sync_all()?;
        temp.persist(&target).map_err(|e| e.error)?;
        Ok(())
    }
    pub(super) async fn prefetch(
        &self,
        backend: &Mutex<Backend>,
        id: &str,
        pages: Option<&Value>,
    ) -> Result<Value> {
        let book = self.snapshot(backend, id)?;
        let pages = pages
            .and_then(Value::as_array)
            .filter(|a| a.len() <= 6)
            .context("最多预读 6 页")?;
        let epoch = {
            let mut epochs = self.prefetch_epochs.lock().unwrap();
            let next = epochs.get(id).copied().unwrap_or(0).wrapping_add(1);
            epochs.insert(id.into(), next);
            next
        };
        for index in pages {
            if self.prefetch_epochs.lock().unwrap().get(id) != Some(&epoch) {
                break;
            }
            let page = book["pages"]
                .get(index.as_u64().context("无效预读页码")? as usize)
                .context("预读页码越界")?;
            self.asset(backend, id, text(page, "url")?, Some(epoch))
                .await?;
        }
        Ok(Value::Null)
    }
}
