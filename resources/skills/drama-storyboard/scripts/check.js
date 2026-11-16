export function isStoryboardRow(row) {
  return typeof row?.shot === 'string' && row.shot.trim() !== '' &&
    Number.isFinite(row.seconds) && row.seconds > 0
}
