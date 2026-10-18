const express = require("express");
const path = require("path");
const fs = require("fs");
const pool = require("../db");
const { ok, fail } = require("../utils/response");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

function escapeXml(s) {
  return String(s == null ? "" : s).replace(
    /[<>&'"]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[c],
  );
}

function buildArgumentSvg(task, propositions, relations, guidelineVersion) {
  const width = 1000;
  const height = 720;
  const padX = 80;
  const padY = 70;
  const nodeW = 64;
  const nodeH = 38;

  const numToKey = {};
  const pos = {};
  propositions.forEach((p) => {
    const key = p.propCode || p.id;
    const num = Number(String(key).replace(/^p/, ""));
    if (!isNaN(num)) numToKey[num] = key;
    const x =
      padX + (Number(p.x != null ? p.x : 50) / 100) * (width - 2 * padX);
    const y =
      padY + (Number(p.y != null ? p.y : 50) / 100) * (height - 2 * padY);
    pos[key] = { x, y };
  });

  // 统一关系 id：'R1' / 1 / '1' 都归一化为数字 1；非数字保持原样
  function normalizeRelId(relId) {
    const num = Number(String(relId).replace(/^R/, ""));
    return isNaN(num) ? String(relId) : num;
  }

  // 关系 id -> 关系对象（同时注册归一化后的 key）
  const relById = {};
  relations.forEach((r) => {
    relById[normalizeRelId(r.id)] = r;
  });

  // 关系视觉中心（递归处理嵌套端点）
  const relCenter = {};

  function computeRelCenter(relId, seen) {
    const key = normalizeRelId(relId);
    if (relCenter[key]) return relCenter[key];
    if (seen.has(key)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    const rel = relById[key];
    if (!rel) return null;
    const eps = rel.endpoints || [];
    if (eps.length < 2) return null;

    if (rel.type === "J") {
      let sx = 0,
        sy = 0,
        n = 0;
      for (const e of eps) {
        const p = resolveCenter(e, nextSeen);
        if (p) {
          sx += p.x;
          sy += p.y;
          n++;
        }
      }
      if (!n) return null;
      const c = { x: sx / n, y: sy / n };
      relCenter[key] = c;
      return c;
    }

    const p1 = resolveCenter(eps[0], nextSeen);
    const p2 = resolveCenter(eps[1], nextSeen);
    if (!p1 || !p2) return null;
    const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    relCenter[key] = c;
    return c;
  }

  function resolveCenter(e, seen) {
    if (typeof e === "number") {
      const key = numToKey[e];
      return key && pos[key] ? pos[key] : null;
    }
    if (e && typeof e === "object" && e.relationId != null) {
      return computeRelCenter(e.relationId, seen);
    }
    return null;
  }

  function relationRadius(e) {
    if (typeof e !== "object" || !e) return 0;
    const rel = relById[normalizeRelId(e.relationId)];
    if (!rel) return 0;
    if (rel.type === "S" || rel.type === "A") return 5;
    if (rel.type === "M" || rel.type === "J") return 9;
    return 0;
  }

  // 从 center 指向 target 的边界锚点：命题走矩形边框，嵌套关系走圆圈半径
  function anchorEdge(e, center, target) {
    const dx = target.x - center.x;
    const dy = target.y - center.y;
    if (!dx && !dy) return center;
    if (typeof e === "number") {
      const sx = dx === 0 ? Infinity : nodeW / 2 / Math.abs(dx);
      const sy = dy === 0 ? Infinity : nodeH / 2 / Math.abs(dy);
      const s = Math.min(sx, sy);
      return { x: center.x + dx * s, y: center.y + dy * s };
    }
    const r = relationRadius(e);
    if (!r) return center;
    const d = Math.hypot(dx, dy);
    if (!d) return center;
    return { x: center.x + (dx / d) * r, y: center.y + (dy / d) * r };
  }

  // 预计算所有关系中心（嵌套端点可递归解析）
  relations.forEach((r) => computeRelCenter(r.id, new Set()));

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(
    `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" fill="#17233b"/></marker></defs>`,
  );
  parts.push(
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
  );
  parts.push(
    `<text x="${padX}" y="36" font-family="Microsoft YaHei, sans-serif" font-size="18" font-weight="700" fill="#17233b">${escapeXml(task.name)} · 论证图示</text>`,
  );
  parts.push(
    `<text x="${padX}" y="56" font-family="Microsoft YaHei, sans-serif" font-size="11" fill="#71809a">指南版本 ${escapeXml(guidelineVersion || "v1.2")} · 命题 ${propositions.length} 个 · 关系 ${relations.length} 条</text>`,
  );

  relations.forEach((r) => {
    const eps = r.endpoints || [];
    if (eps.length < 2) return;

    if (r.type === "J") {
      const c = relCenter[normalizeRelId(r.id)];
      if (!c) return;
      eps.forEach((e) => {
        const epCenter = resolveCenter(e, new Set());
        if (!epCenter) return;
        const start = anchorEdge(e, epCenter, c);
        const dx = start.x - c.x,
          dy = start.y - c.y;
        const d = Math.hypot(dx, dy);
        const end =
          d > 9 ? { x: c.x + (dx / d) * 9, y: c.y + (dy / d) * 9 } : c;
        parts.push(
          `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="#17233b" stroke-width="1.4"/>`,
        );
      });
      parts.push(
        `<circle cx="${c.x}" cy="${c.y}" r="9" fill="#ffffff" stroke="#586782" stroke-width="1.2"/>`,
      );
      parts.push(
        `<text x="${c.x}" y="${c.y + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#40516e">+</text>`,
      );
      return;
    }

    const [ea, eb] = eps;
    const ca = resolveCenter(ea, new Set());
    const cb = resolveCenter(eb, new Set());
    if (!ca || !cb) return;

    if (r.type === "I") {
      const start = anchorEdge(ea, ca, cb);
      const end = anchorEdge(eb, cb, ca);
      parts.push(
        `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="#6a8fe8" stroke-width="1.4" stroke-dasharray="4 3"/>`,
      );
      const mx = (start.x + end.x) / 2;
      const my = (start.y + end.y) / 2;
      parts.push(
        `<rect x="${mx - 12}" y="${my - 8}" width="24" height="16" rx="3" fill="#eef4ff" stroke="#6a8fe8"/>`,
      );
      parts.push(
        `<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="10" fill="#315bd0">/</text>`,
      );
      return;
    }

    const start = anchorEdge(ea, ca, cb);
    const end = anchorEdge(eb, cb, ca);
    parts.push(
      `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="#17233b" stroke-width="1.6" marker-end="url(#arrow)"/>`,
    );
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    if (r.type === "S") {
      parts.push(`<circle cx="${mx}" cy="${my}" r="5" fill="#17233b"/>`);
    } else if (r.type === "A") {
      parts.push(
        `<circle cx="${mx}" cy="${my}" r="5" fill="#ffffff" stroke="#17233b" stroke-width="1.5"/>`,
      );
    } else if (r.type === "M") {
      parts.push(
        `<circle cx="${mx}" cy="${my}" r="9" fill="#ffffff" stroke="#586782" stroke-width="1.2"/>`,
      );
      parts.push(
        `<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#40516e">+</text>`,
      );
    }
  });

  propositions.forEach((p) => {
    const key = p.propCode || p.id;
    const c = pos[key];
    if (!c) return;
    const x = c.x - nodeW / 2;
    const y = c.y - nodeH / 2;
    parts.push(
      `<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="8" fill="#ffffff" stroke="#cbd5e8"/>`,
    );
    parts.push(
      `<text x="${c.x}" y="${c.y + 5}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="14" font-weight="700" fill="#3767e8">${escapeXml(key)}</text>`,
    );
  });

  parts.push(
    `<text x="${padX}" y="${height - 20}" font-family="Microsoft YaHei, sans-serif" font-size="11" fill="#71809a">● 支持　○ 反对　+ 组合/匹配　/ 同一　→ 方向</text>`,
  );
  parts.push("</svg>");
  return parts.join("\n");
}

const RELATION_TYPE_NAMES = {
  S: "支持关系",
  A: "反对关系",
  M: "匹配关系",
  J: "组合关系",
  I: "同一关系",
};

// 标签来源：优先任务创建时的快照；为空时回退全局 labels 表
async function loadTaskLabels(task) {
  let snap = task.labels_json;
  if (typeof snap === "string") {
    try {
      snap = JSON.parse(snap);
    } catch {
      snap = null;
    }
  }
  if (snap && (Array.isArray(snap.primary) || Array.isArray(snap.secondary))) {
    return {
      source: "task_snapshot",
      primary: (snap.primary || []).map((l) => ({
        code: l.code,
        name: l.name,
        level: "primary",
      })),
      secondary: (snap.secondary || []).map((l) => ({
        code: l.code,
        name: l.name,
        level: "secondary",
        parentCode: l.parentCode || null,
      })),
    };
  }
  const [rows] = await pool.query(
    "SELECT code, name, parent_code, level FROM labels WHERE enabled = 1 ORDER BY level, sort_order",
  );
  return {
    source: "global_labels",
    primary: rows
      .filter((r) => r.level === "primary")
      .map((r) => ({
        code: r.code,
        name: r.name,
        level: "primary",
      })),
    secondary: rows
      .filter((r) => r.level === "secondary")
      .map((r) => ({
        code: r.code,
        name: r.name,
        level: "secondary",
        parentCode: r.parent_code || null,
      })),
  };
}

// 关系矩阵：行是源命题，列是目标命题；J/I 多端点标记所有有序对
function buildRelationMatrix(propositions, relations) {
  const codes = propositions.map((p) => p.id);
  const matrix = {};
  codes.forEach((a) => {
    matrix[a] = {};
    codes.forEach((b) => {
      matrix[a][b] = null;
    });
  });
  relations.forEach((r) => {
    const eps = (r.endpoints || []).filter((e) => typeof e === "number");
    if (r.type === "J" || r.type === "I") {
      for (let i = 0; i < eps.length; i++) {
        for (let j = 0; j < eps.length; j++) {
          if (i === j) continue;
          const a = "p" + eps[i];
          const b = "p" + eps[j];
          if (matrix[a] && matrix[a][b] !== undefined) matrix[a][b] = r.type;
        }
      }
    } else if (eps.length >= 2) {
      const a = "p" + eps[0];
      const b = "p" + eps[1];
      if (matrix[a] && matrix[a][b] !== undefined) matrix[a][b] = r.type;
    }
  });
  return matrix;
}

function buildJsonPayload(
  task,
  propositions,
  relations,
  labels,
  relationMatrix,
  guidelineVersion,
) {
  return {
    guidelineVersion: guidelineVersion || "v1.2",
    exportedAt: new Date().toISOString(),
    task: {
      id: task.id,
      taskCode: task.task_code,
      name: task.name,
      caseType: task.case_type,
    },
    labels: {
      source: labels.source,
      primary: labels.primary,
      secondary: labels.secondary,
    },
    propositions: propositions.map((p) => ({
      id: p.id,
      text: p.text || "",
      primaryLabel: p.primaryLabel || null,
      secondaryLabel: p.label || null,
      characterIndex: {
        start: p.start != null ? p.start : null,
        end: p.end != null ? p.end : null,
      },
      position: {
        x: p.x != null ? p.x : null,
        y: p.y != null ? p.y : null,
      },
    })),
    relations: relations.map((r) => ({
      id: r.id,
      type: r.type,
      typeName: RELATION_TYPE_NAMES[r.type] || r.type,
      endpoints: (r.endpoints || []).map((e) => {
        if (typeof e === "number") return { kind: "proposition", id: "p" + e };
        if (e && e.relationId != null)
          return { kind: "relation", id: "R" + e.relationId };
        return { kind: "unknown", id: String(e) };
      }),
      expression: r.expression || null,
    })),
    relationMatrix,
  };
}

async function buildExcelBuffer(
  task,
  propositions,
  relations,
  guidelineVersion,
  labels,
) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "论证标注工作台";
  wb.created = new Date();

  const primaryNameMap = {};
  const secondaryNameMap = {};
  (labels.primary || []).forEach((l) => {
    primaryNameMap[l.code] = l.name;
  });
  (labels.secondary || []).forEach((l) => {
    secondaryNameMap[l.code] = l.name;
  });

  // 1. 元信息
  const meta = wb.addWorksheet("元信息");
  meta.columns = [{ width: 16 }, { width: 46 }];
  meta.addRow(["任务名称", task.name]);
  meta.addRow(["任务编号", task.task_code]);
  meta.addRow(["案例类型", task.case_type]);
  meta.addRow(["指南版本", guidelineVersion || "v1.2"]);
  meta.addRow(["导出时间", new Date().toISOString()]);
  meta.addRow(["命题数量", propositions.length]);
  meta.addRow(["关系数量", relations.length]);
  meta.addRow(["标签来源", labels.source || ""]);

  // 2. 命题
  const propSheet = wb.addWorksheet("命题");
  propSheet.columns = [
    { header: "命题编号", key: "id", width: 10 },
    { header: "命题文本", key: "text", width: 60 },
    { header: "一级标签编码", key: "primaryLabel", width: 14 },
    { header: "一级标签名称", key: "primaryName", width: 18 },
    { header: "二级标签编码", key: "label", width: 14 },
    { header: "二级标签名称", key: "labelName", width: 18 },
    { header: "起始位置", key: "start", width: 10 },
    { header: "结束位置", key: "end", width: 10 },
    { header: "图示X", key: "x", width: 8 },
    { header: "图示Y", key: "y", width: 8 },
  ];
  propositions.forEach((p) => {
    propSheet.addRow({
      id: p.id,
      text: p.text || "",
      primaryLabel: p.primaryLabel || "",
      primaryName: primaryNameMap[p.primaryLabel] || "",
      label: p.label || "",
      labelName: secondaryNameMap[p.label] || "",
      start: p.start != null ? p.start : "",
      end: p.end != null ? p.end : "",
      x: p.x != null ? p.x : "",
      y: p.y != null ? p.y : "",
    });
  });
  propSheet.getRow(1).font = { bold: true };
  propSheet.views = [{ state: "frozen", ySplit: 1 }];

  // 3. 关系
  const relSheet = wb.addWorksheet("关系");
  relSheet.columns = [
    { header: "关系编号", key: "id", width: 10 },
    { header: "类型", key: "type", width: 8 },
    { header: "类型名称", key: "typeName", width: 12 },
    { header: "端点", key: "endpoints", width: 30 },
    { header: "表达式", key: "expression", width: 26 },
  ];
  relations.forEach((r) => {
    const eps = (r.endpoints || []).map((e) => {
      if (typeof e === "number") return "p" + e;
      if (e && e.relationId != null) return "R" + e.relationId;
      return String(e);
    });
    relSheet.addRow({
      id: r.id,
      type: r.type,
      typeName: RELATION_TYPE_NAMES[r.type] || r.type,
      endpoints: eps.join(", "),
      expression: r.expression || "",
    });
  });
  relSheet.getRow(1).font = { bold: true };
  relSheet.views = [{ state: "frozen", ySplit: 1 }];

  // 4. 标签
  const labelSheet = wb.addWorksheet("标签");
  labelSheet.columns = [
    { header: "标签编码", key: "code", width: 14 },
    { header: "标签名称", key: "name", width: 22 },
    { header: "层级", key: "level", width: 10 },
    { header: "父级编码", key: "parentCode", width: 14 },
  ];
  (labels.primary || []).forEach((l) => {
    labelSheet.addRow({
      code: l.code,
      name: l.name,
      level: "一级",
      parentCode: "",
    });
  });
  (labels.secondary || []).forEach((l) => {
    labelSheet.addRow({
      code: l.code,
      name: l.name,
      level: "二级",
      parentCode: l.parentCode || "",
    });
  });
  labelSheet.getRow(1).font = { bold: true };
  labelSheet.views = [{ state: "frozen", ySplit: 1 }];

  // 5. 关系矩阵
  const matrix = buildRelationMatrix(propositions, relations);
  const codes = propositions.map((p) => p.id);
  const matrixSheet = wb.addWorksheet("关系矩阵");

  const header = ["源 \\ 目标", ...codes];
  const rows = [header];
  codes.forEach((a) => {
    const row = [a];
    codes.forEach((b) => {
      row.push(matrix[a] && matrix[a][b] ? matrix[a][b] : "");
    });
    rows.push(row);
  });

  matrixSheet.columns = header.map((h, i) => ({
    header: h,
    key: "c" + i,
    width: i === 0 ? 14 : 10,
  }));
  rows.slice(1).forEach((row) => {
    const obj = {};
    row.forEach((v, i) => {
      obj["c" + i] = v;
    });
    matrixSheet.addRow(obj);
  });
  matrixSheet.getRow(1).font = { bold: true };
  matrixSheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

  // 6. 图例
  const usedTypes = new Set();
  Object.keys(matrix).forEach((a) => {
    Object.keys(matrix[a]).forEach((b) => {
      if (matrix[a][b]) usedTypes.add(matrix[a][b]);
    });
  });
  const legendRow = matrixSheet.rowCount + 2;
  matrixSheet.getCell(legendRow, 1).value = "图例";
  matrixSheet.getCell(legendRow, 1).font = { bold: true };
  Array.from(usedTypes)
    .sort()
    .forEach((t, i) => {
      matrixSheet.getCell(legendRow + 1 + i, 1).value = t;
      matrixSheet.getCell(legendRow + 1 + i, 2).value =
        RELATION_TYPE_NAMES[t] || t;
    });

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// 请求导出：按 format 生成 JSON / Excel / SVG
router.post("/", authRequired, async (req, res) => {
  const { taskId, filename, format, guidelineVersion, positions } =
    req.body || {};
  if (!taskId) return fail(res, "缺少任务 ID");
  const fmt = String(format || "JSON").toUpperCase();
  if (!["JSON", "EXCEL", "SVG"].includes(fmt)) {
    return fail(res, "不支持的导出格式：" + format);
  }

  try {
    const [taskRows] = await pool.query(
      "SELECT * FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    const task = taskRows[0];
    if (!task) return fail(res, "任务不存在");
    if (!task.adjudicated) return fail(res, "任务尚未完成裁定");

    let finalVersionId = task.final_annotation_version_id;
    if (!finalVersionId) {
      const [verRows] = await pool.query(
        'SELECT id FROM annotation_versions WHERE task_id = ? AND status = "final" ORDER BY version_no DESC LIMIT 1',
        [taskId],
      );
      finalVersionId = verRows[0] ? verRows[0].id : null;
    }
    if (!finalVersionId) return fail(res, "该任务尚未生成最终版本");

    const [pRows] = await pool.query(
      "SELECT prop_code, text, primary_label, secondary_label, start_index, end_index, pos_x, pos_y FROM propositions WHERE annotation_version_id = ? ORDER BY sort_order",
      [finalVersionId],
    );
    const [rRows] = await pool.query(
      "SELECT rel_code, type, endpoints, expression FROM relations WHERE annotation_version_id = ?",
      [finalVersionId],
    );

    const propositions = pRows.map((p) => ({
      id: p.prop_code,
      propCode: p.prop_code,
      text: p.text,
      primaryLabel: p.primary_label,
      label: p.secondary_label,
      start: p.start_index,
      end: p.end_index,
      x: p.pos_x != null ? Number(p.pos_x) : 50,
      y: p.pos_y != null ? Number(p.pos_y) : 50,
    }));

    // 用前端传来的本地布局覆盖坐标（仅影响本次导出，不写库）
    // 用户拖拽后的布局只存在于自己的浏览器，导出时通过该字段带上来
    if (Array.isArray(positions) && positions.length) {
      const posMap = {};
      positions.forEach((p) => {
        const code = String((p && p.propCode) || "").trim();
        const x = Number(p && p.x);
        const y = Number(p && p.y);
        if (!code || !isFinite(x) || !isFinite(y)) return;
        posMap[code] = {
          x: Math.max(0, Math.min(100, x)),
          y: Math.max(0, Math.min(100, y)),
        };
      });
      propositions.forEach((p) => {
        const key = p.propCode || p.id;
        const s = posMap[key];
        if (s) {
          p.x = s.x;
          p.y = s.y;
        }
      });
    }

    const relations = rRows.map((r) => {
      const eps =
        typeof r.endpoints === "string"
          ? JSON.parse(r.endpoints)
          : r.endpoints || [];
      return {
        id: r.rel_code,
        type: r.type,
        endpoints: eps,
        expression: r.expression,
      };
    });

    const safeName = String(filename || task.name + "_论证标注").replace(
      /[\\/:*?"<>|]/g,
      "_",
    );
    const ext = fmt === "JSON" ? ".json" : fmt === "EXCEL" ? ".xlsx" : ".svg";
    const outDir = path.join(__dirname, "..", "exports");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, safeName + ext);

    const labels = await loadTaskLabels(task);
    const relationMatrix = buildRelationMatrix(propositions, relations);

    if (fmt === "JSON") {
      const payload = buildJsonPayload(
        task,
        propositions,
        relations,
        labels,
        relationMatrix,
        guidelineVersion,
      );
      fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
    } else if (fmt === "SVG") {
      const svg = buildArgumentSvg(
        task,
        propositions,
        relations,
        guidelineVersion,
      );
      fs.writeFileSync(outFile, svg, "utf8");
    } else {
      const buf = await buildExcelBuffer(
        task,
        propositions,
        relations,
        guidelineVersion,
        labels,
      );
      fs.writeFileSync(outFile, buf);
    }

    const relativePath = `/exports/${path.basename(outFile)}`;
    // 生成对外可访问的完整下载地址：
    // - 优先 PUBLIC_BASE_URL（反向代理 / CDN 部署时配置，如 https://api.example.com）
    // - 否则用当前请求的协议 + Host
    // - 数据库只存相对路径，域名迁移后历史记录仍可用
    const baseUrl =
      (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "") ||
      req.protocol + "://" + req.get("host");
    const downloadUrl = baseUrl + relativePath;
    await pool.query(
      "INSERT INTO exports (task_id, filename, format, guideline_version, download_url, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      [
        taskId,
        safeName,
        fmt,
        guidelineVersion || "v1.2",
        relativePath,
        req.user.id,
      ],
    );

    ok(res, {
      downloadUrl,
      relativePath,
      filename: safeName,
      format: fmt,
      ext,
    });
  } catch (e) {
    fail(res, "导出失败：" + e.message);
  }
});

module.exports = router;
