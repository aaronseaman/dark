// OPFS writes via SyncAccessHandle for Safari builds without createWritable().
self.onmessage = async (e) => {
  const { id, path, blob } = e.data;
  let handle = null;
  try {
    const parts = path.split('/');
    const name = parts.pop();
    let d = await navigator.storage.getDirectory();
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
    const fh = await d.getFileHandle(name, { create: true });
    handle = await fh.createSyncAccessHandle();
    const buf = new Uint8Array(await blob.arrayBuffer());
    await handle.truncate(0);
    await handle.write(buf, { at: 0 });
    await handle.flush();
    await handle.close();
    handle = null;
    self.postMessage({ id });
  } catch (err) {
    try { if (handle) await handle.close(); } catch { /* ignore */ }
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
