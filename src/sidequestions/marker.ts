const markerPrefix = (turnId: string, label = '旁问编号') => `[DS Margin ${label}：${turnId}；`;

export function sideQuestionMarker(turnId: string): string {
  return markerPrefix(turnId) + '用于识别本次旁问，请勿复述。]';
}

const markerText = (text: string) => text.normalize('NFKC').replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, '');

export function hasSideQuestionMarker(text: string, turnId: string): boolean {
  const normalized = markerText(text);
  return normalized.includes(markerText(markerPrefix(turnId))) ||
    normalized.includes(markerText(markerPrefix(turnId, '任务编号')));
}

export function hasRawSideQuestionMarker(text: string, turnId: string): boolean {
  return text.includes(markerPrefix(turnId)) || text.includes(markerPrefix(turnId, '任务编号'));
}

export function readSideQuestionTurnId(text: string): string | undefined {
  if (!text.includes('用于识别本次旁问')) return undefined;
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  return normalized.match(/\[DS\s+Margin\s+(?:旁问|任务)编号:\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*;\s*用于识别本次旁问[,，]\s*请勿复述[.。]\]\s*$/i)?.[1];
}
