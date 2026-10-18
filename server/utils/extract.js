/**
 * 裁判理由提取
 * 按案例类型走不同策略：
 *   - guiding   指导性案例：裁判要旨 → 本院认为 → 判决如下
 *   - reference 参考案例：  参考案例要旨 → 本院认为 → 判决如下
 *   - ordinary  普通案例：  本院认为 → 判决如下
 */

// 起点标记
const START_MARKERS =
  /(?:^|[\r\n。；])\s*(本院认为|本庭认为|裁判理由(?:如下)?|本院经审理认为)/m;
// 终止标记
const END_MARKERS =
  /(?:判决如下|裁定如下|裁判如下|裁判结果|判决主文|综上(?:所述)?[，。,：:]?)/;
// 摘要标记
const DIGEST_MARKERS = /(?:裁判要旨|裁判摘要|要点提示)/;

// ---------- 通用工具 ----------

// 从指定位置往后找第一个匹配，返回 { index, length } 或 null
function findAfter(text, pattern, fromIndex) {
  pattern.lastIndex = 0;
  const slice = text.slice(fromIndex);
  const m = pattern.exec(slice);
  if (!m) return null;
  return { index: fromIndex + m.index, length: m[0].length };
}

// 从指定位置往前找最后一个匹配
function findBefore(text, pattern, toIndex) {
  const slice = text.slice(0, toIndex);
  let last = null;
  let m;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(slice)) !== null) {
    last = { index: m.index, length: m[0].length };
    pattern.lastIndex = m.index + 1;
  }
  return last;
}

// 清理首尾空白，返回调整后的 range
function trimRange(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

// ---------- 通用规则匹配（普通案例） ----------

function matchOrdinary(text) {
  const startPattern =
    /(?:^|[\r\n。；])\s*(本院认为|本庭认为|裁判理由(?:如下)?|本院经审理认为)/m;
  const startMatch = startPattern.exec(text);
  if (!startMatch) return null;
  const start = startMatch.index + startMatch[0].lastIndexOf(startMatch[1]);
  const tail = text.slice(start + startMatch[1].length);
  const endMatch = END_MARKERS.exec(tail);
  const end = endMatch
    ? start + startMatch[1].length + endMatch.index
    : text.length;
  const r = trimRange(text, start, end);
  return r.end > r.start ? r : null;
}

// ---------- 指导性案例 ----------

function matchGuiding(text) {
  // 1. 优先找"指导性案例 / 指导案例"标题，或"裁判要旨"摘要标记
  const guidingMatch = /(?:指导性案例|指导案例)[^\r\n]*|裁判要旨/.exec(text);
  let anchor = null;
  if (guidingMatch) {
    anchor = { index: guidingMatch.index, length: guidingMatch[0].length };
  }

  // 2. 从 anchor 之后（或全文开头）找"本院认为"作为实际起点
  const searchFrom = anchor ? anchor.index + anchor.length : 0;
  const reason = findAfter(
    text,
    /(?:本院认为|本庭认为|裁判理由|本院经审理认为)/g,
    searchFrom,
  );

  // 3. 计算最终起点
  let start, headerLen;
  if (reason) {
    start = reason.index;
    headerLen = reason.length;
  } else if (anchor) {
    start = anchor.index;
    headerLen = anchor.length;
  } else {
    // 找不到指导性案例特征，回退普通规则
    return null;
  }

  // 4. 找终止点
  const tail = text.slice(start + headerLen);
  const endMatch = END_MARKERS.exec(tail);
  const end = endMatch ? start + headerLen + endMatch.index : text.length;
  const r = trimRange(text, start, end);
  return r.end > r.start ? r : null;
}

// ---------- 参考案例 ----------

function matchReference(text) {
  const refMatch = /(?:参考案例|参考案例要旨|裁判要旨)/.exec(text);
  let anchor = null;
  if (refMatch) {
    anchor = { index: refMatch.index, length: refMatch[0].length };
  }

  const searchFrom = anchor ? anchor.index + anchor.length : 0;
  const reason = findAfter(
    text,
    /(?:本院认为|本庭认为|裁判理由|裁判要旨)/g,
    searchFrom,
  );

  let start, headerLen;
  if (reason) {
    start = reason.index;
    headerLen = reason.length;
  } else if (anchor) {
    start = anchor.index;
    headerLen = anchor.length;
  } else {
    return null;
  }

  const tail = text.slice(start + headerLen);
  const endMatch = END_MARKERS.exec(tail);
  const end = endMatch ? start + headerLen + endMatch.index : text.length;
  const r = trimRange(text, start, end);
  return r.end > r.start ? r : null;
}

// ---------- 对外接口 ----------

function matchReasonSection(text, caseType) {
  if (!text) return null;
  const type = caseType || "ordinary";
  if (type === "guiding") {
    return matchGuiding(text) || matchOrdinary(text);
  }
  if (type === "reference") {
    return matchReference(text) || matchOrdinary(text);
  }
  return matchOrdinary(text);
}

/**
 * @param {string} text        文书全文
 * @param {string} strategy    提取策略：auto / keyword / rules
 * @param {string} caseType    案例类型：ordinary / guiding / reference
 * @returns {{ start, end, text, method }}
 */
function extractReason(text, strategy, caseType) {
  if (!text) return { start: 0, end: 0, text: "", method: "无文本" };

  const type = caseType || "ordinary";
  const useKeyword = strategy !== "rules";

  // keyword 或 auto：先按案例类型走关键词定位
  if (useKeyword) {
    let range = null;
    let method = "";
    if (type === "guiding") {
      range = matchGuiding(text);
      method = "指导性案例关键词定位";
    } else if (type === "reference") {
      range = matchReference(text);
      method = "参考案例关键词定位";
    } else {
      range = matchOrdinary(text);
      method = "普通案例规则匹配";
    }
    if (range) {
      return {
        start: range.start,
        end: range.end,
        text: text.slice(range.start, range.end).trim(),
        method,
      };
    }
    // 关键词未命中，回退到通用规则
    range = matchOrdinary(text);
    if (range) {
      return {
        start: range.start,
        end: range.end,
        text: text.slice(range.start, range.end).trim(),
        method: "关键词未命中，已回退规则匹配",
      };
    }
    return { start: 0, end: 0, text: "", method: "未匹配" };
  }

  // rules：强制走通用规则匹配
  const range = matchOrdinary(text);
  if (!range) return { start: 0, end: 0, text: "", method: "未匹配" };
  return {
    start: range.start,
    end: range.end,
    text: text.slice(range.start, range.end).trim(),
    method: "规则匹配",
  };
}

module.exports = { extractReason, matchReasonSection };
