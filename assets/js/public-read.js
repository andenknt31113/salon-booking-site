const PUBLIC_READ_FRAME_MAX_DEPTH = 8;

async function readPublicEndpoint(payload, signal) {
  const valid = payload && ['menu', 'availability'].includes(payload.type)
    && Object.keys(payload).every(key => ['type', 'booking', 'initialAvailability'].includes(key))
    && (payload.type !== 'menu' || payload.booking === true);
  if (!valid) throw new Error('公開の読取要求を確認できません。');
  if (signal && signal.aborted) throw new DOMException('読取を中止しました。', 'AbortError');
  const post = () => fetch(SALON.reservationEndpoint, {
    method: 'POST', cache: 'no-store', signal,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload)
  });
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(SALON.reservationEndpoint)
      || location.origin === 'null' || !crypto.randomUUID) return post();
  try {
    const result = await new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      const requestId = crypto.randomUUID();
      const url = new URL(SALON.reservationEndpoint);
      url.search = new URLSearchParams({ transport: 'frame', type: payload.type,
        requestId, origin: location.origin });
      frame.src = url.href;
      frame.hidden = true;
      frame.title = '最新の予約条件を確認';
      frame.referrerPolicy = 'no-referrer';
      frame.sandbox = 'allow-scripts allow-same-origin';
      let timeout;
      const finish = (error, data) => {
        clearTimeout(timeout);
        window.removeEventListener('message', receive);
        if (signal) signal.removeEventListener('abort', abort);
        frame.remove();
        if (error) reject(error); else resolve(data);
      };
      const abort = () => finish(new DOMException('読取を中止しました。', 'AbortError'));
      const receive = event => {
        const data = event.data;
        if (!/^https:\/\/(?:[a-z0-9-]+-)?script\.googleusercontent\.com$/.test(event.origin)
            || !data || data.type !== 'zer01-public-read' || data.requestId !== requestId
            || !data.result || typeof data.result !== 'object' || typeof data.result.ok !== 'boolean') return;
        try {
          let source = event.source;
          for (let depth = 0; source && depth < PUBLIC_READ_FRAME_MAX_DEPTH; depth++) {
            if (source === frame.contentWindow) { finish(null, data.result); return; }
            if (source === source.parent) return;
            source = source.parent;
          }
        } catch {}
      };
      window.addEventListener('message', receive);
      if (signal) signal.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(() => finish(new Error('読取フレームの応答を確認できません。')),
        SALON.publicReadFrameTimeoutMs);
      frame.onerror = () => finish(new Error('読取フレームを開けません。'));
      try { document.body.append(frame); } catch (error) { finish(error); }
    });
    return { ok: true, json: async () => result };
  } catch (error) {
    if (signal && signal.aborted) throw error;
    return post();
  }
}
