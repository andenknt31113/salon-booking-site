const AdminData = (() => {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const scalar = value => value === null || ['string', 'boolean'].includes(typeof value)
    || typeof value === 'number' && Number.isFinite(value);
  const values = value => record(value) && Object.values(value).every(scalar);
  const rows = (value, key) => Array.isArray(value)
    && value.every(row => values(row) && Object.hasOwn(row, key));

  function validStartup(result) {
    if (!record(result) || result.ok !== true || !Array.isArray(result.reservations)
        || !result.reservations.every(row => values(row)
          && typeof row.code === 'string' && row.code.trim()
          && ['date', 'time', 'endTime', 'name', 'tel', 'status'].every(key => typeof row[key] === 'string')
          && typeof row.price === 'number' && Number.isFinite(row.price)
          && (row.detailsPending === undefined
            || row.detailsPending === true && row.note === undefined && row.request === undefined))
        || new Set(result.reservations.map(row => row.code)).size !== result.reservations.length
        || !rows(result.closedDates, '休業日') || !result.closedDates.every(row => typeof row.休業日 === 'string')
        || !rows(result.menus, 'メニュー名') || !rows(result.coupons, 'メニュー名')
        || !values(result.settings) || !record(result.stamps)) return false;
    const pending = result.pendingEditors === undefined ? [] : result.pendingEditors;
    if (!Array.isArray(pending) || pending.some(target => !['styles', 'reviews'].includes(target))
        || new Set(pending).size !== pending.length) return false;
    const targets = ['closed', 'menus', 'coupons', 'settings'];
    for (const [target, key] of [['styles', 'タイトル'], ['reviews', '投稿日']]) {
      if (pending.includes(target)) {
        if (Object.hasOwn(result, target)) return false;
      } else {
        if (!rows(result[target], key)) return false;
        targets.push(target);
      }
    }
    if (!targets.every(target => typeof result.stamps[target] === 'string'
        && result.stamps[target].trim())) return false;
    return result.capabilities === undefined || record(result.capabilities)
      && ['phoneRequestIds', 'adminChange'].every(key => result.capabilities[key] === undefined
        || typeof result.capabilities[key] === 'boolean');
  }

  return Object.freeze({ validStartup });
})();
