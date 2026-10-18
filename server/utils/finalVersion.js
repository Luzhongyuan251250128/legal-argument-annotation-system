/**
 * 根据逐项裁定决策，重建最终标注版本
 */

function normalizeText(t) {
  return String(t || "")
    .replace(/\s+/g, "")
    .replace(/[，。；：、！？""''（）《》【】,.;:!?()\[\]"']/g, "");
}

function parseLabelValue(value) {
  const v = String(value || "").trim();
  if (!v) return { primary: "", secondary: "" };
  const parts = v
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { primary: parts[0], secondary: parts[1] };
  return { primary: v, secondary: v };
}

function parseRelationValue(value) {
  const v = String(value || "").trim();
  const m = v.match(/^([SAMJI])\((.+)\)$/);
  if (!m) return null;
  const type = m[1];
  const endpoints = m[2]
    .split(",")
    .map((s) => {
      const p = s.trim().match(/^p(\d+)$/);
      return p ? Number(p[1]) : null;
    })
    .filter((n) => n !== null);
  if (endpoints.length < 2) return null;
  return { type, endpoints };
}

function formatExpression(type, endpoints) {
  const names = endpoints.map((n) => "p" + n);
  if (type === "J" || type === "I") return type + "(" + names.join(", ") + ")";
  return type + "(" + names.slice(0, 2).join(", ") + ")";
}

async function loadVersionData(conn, taskId) {
  const [versions] = await conn.query(
    `SELECT id, annotator_id, version_no
       FROM annotation_versions
      WHERE task_id = ? AND status IN ('submitted','final')
      ORDER BY version_no, id`,
    [taskId],
  );
  const data = [];
  for (const v of versions) {
    const [props] = await conn.query(
      `SELECT prop_code, text, primary_label, secondary_label, start_index, end_index, pos_x, pos_y, sort_order
         FROM propositions WHERE annotation_version_id = ? ORDER BY sort_order`,
      [v.id],
    );
    const [rels] = await conn.query(
      `SELECT rel_code, type, endpoints, expression FROM relations WHERE annotation_version_id = ?`,
      [v.id],
    );
    data.push({ ...v, propositions: props, relations: rels });
  }
  return data;
}

async function copyVersion(
  conn,
  srcVersionId,
  taskId,
  adjudicatorId,
  versionNo,
) {
  const [props] = await conn.query(
    `SELECT prop_code, text, primary_label, secondary_label, start_index, end_index, pos_x, pos_y, sort_order
       FROM propositions WHERE annotation_version_id = ? ORDER BY sort_order`,
    [srcVersionId],
  );
  const [rels] = await conn.query(
    `SELECT rel_code, type, endpoints, expression FROM relations WHERE annotation_version_id = ?`,
    [srcVersionId],
  );
  const [ins] = await conn.query(
    `INSERT INTO annotation_versions (task_id, annotator_id, version_no, status, submitted_at)
     VALUES (?, ?, ?, 'final', NOW())`,
    [taskId, adjudicatorId, versionNo],
  );
  const finalId = ins.insertId;
  for (const p of props) {
    await conn.query(
      `INSERT INTO propositions
         (annotation_version_id, prop_code, text, primary_label, secondary_label, start_index, end_index, pos_x, pos_y, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finalId,
        p.prop_code,
        p.text,
        p.primary_label,
        p.secondary_label,
        p.start_index,
        p.end_index,
        p.pos_x,
        p.pos_y,
        p.sort_order,
      ],
    );
  }
  for (const r of rels) {
    await conn.query(
      `INSERT INTO relations (annotation_version_id, rel_code, type, endpoints, expression)
       VALUES (?, ?, ?, ?, ?)`,
      [finalId, r.rel_code, r.type, JSON.stringify(r.endpoints), r.expression],
    );
  }
  return finalId;
}

/**
 * @returns {Promise<number|null>} 最终版本 id
 */
async function buildFinalVersion(
  conn,
  taskId,
  decisions,
  adjudicatorId,
  globalRelabelData,
) {
  const versionData = await loadVersionData(conn, taskId);
  if (!versionData.length) return null;

  const versionNo = Math.max(...versionData.map((v) => v.version_no)) + 1;
  const hasDecisions = Array.isArray(decisions) && decisions.length > 0;

  // 如果存在全局重标数据，以最后一次重标的结果为准
  if (globalRelabelData && Array.isArray(globalRelabelData.propositions)) {
    const local = globalRelabelData;
    const [ins] = await conn.query(
      `INSERT INTO annotation_versions (task_id, annotator_id, version_no, status, submitted_at)
       VALUES (?, ?, ?, 'final', NOW())`,
      [taskId, adjudicatorId, versionNo],
    );
    const finalId = ins.insertId;

    for (let i = 0; i < local.propositions.length; i++) {
      const p = local.propositions[i];
      await conn.query(
        `INSERT INTO propositions
           (annotation_version_id, prop_code, text, primary_label, secondary_label, start_index, end_index, pos_x, pos_y, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          finalId,
          p.propCode || "p" + (i + 1),
          p.text,
          p.primaryLabel || null,
          p.label || null,
          p.start != null ? p.start : null,
          p.end != null ? p.end : null,
          p.x != null ? p.x : 50,
          p.y != null ? p.y : 50,
          i,
        ],
      );
    }
    for (let i = 0; i < local.relations.length; i++) {
      const r = local.relations[i];
      const eps =
        r.endpoints && r.endpoints.length
          ? r.endpoints
          : [r.from, r.to].filter((v) => v != null);
      await conn.query(
        "INSERT INTO relations (annotation_version_id, rel_code, type, endpoints, expression) VALUES (?, ?, ?, ?, ?)",
        [
          finalId,
          r.relCode || "R" + (i + 1),
          r.type,
          JSON.stringify(eps),
          r.expression || null,
        ],
      );
    }
    return finalId;
  }

  // 单版本或无差异：直接复制第一个版本
  if (versionData.length === 1 || !hasDecisions) {
    return copyVersion(
      conn,
      versionData[0].id,
      taskId,
      adjudicatorId,
      versionNo,
    );
  }

  const decisionByKey = {};
  decisions.forEach((d) => {
    decisionByKey[d.key] = d;
  });

  // 1. 命题并集
  const propMap = new Map();
  versionData.forEach((v, vi) => {
    v.propositions.forEach((p) => {
      const key = normalizeText(p.text);
      if (!key) return;
      if (!propMap.has(key)) {
        propMap.set(key, {
          key,
          text: p.text,
          firstProp: p,
          presentIn: new Set(),
          labels: {},
        });
      }
      const e = propMap.get(key);
      e.presentIn.add(vi);
      e.labels[vi] = {
        primary: p.primary_label || "",
        secondary: p.secondary_label || "",
      };
    });
  });

  const finalProps = [];
  propMap.forEach((entry, key) => {
    const propDecision = decisionByKey["prop:" + key];
    let included = true;
    let text = entry.text;
    if (propDecision) {
      if (propDecision.mode === "reject") included = false;
      else if (propDecision.mode === "version")
        included = entry.presentIn.has(propDecision.versionIndex);
      else if (
        propDecision.mode === "relabel" ||
        propDecision.mode === "expert"
      ) {
        text = String(propDecision.value || "").trim() || entry.text;
      }
    } else {
      included = entry.presentIn.size === versionData.length;
    }
    if (!included) return;

    let primary = "";
    let secondary = "";
    const firstVi = Array.from(entry.presentIn)[0];
    if (entry.labels[firstVi]) {
      primary = entry.labels[firstVi].primary;
      secondary = entry.labels[firstVi].secondary;
    }
    const labelDecision = decisionByKey["label:" + key];
    if (labelDecision) {
      if (
        labelDecision.mode === "version" &&
        entry.labels[labelDecision.versionIndex]
      ) {
        primary = entry.labels[labelDecision.versionIndex].primary;
        secondary = entry.labels[labelDecision.versionIndex].secondary;
      } else if (
        labelDecision.mode === "relabel" ||
        labelDecision.mode === "expert"
      ) {
        const parsed = parseLabelValue(labelDecision.value);
        primary = parsed.primary;
        secondary = parsed.secondary;
      }
    }
    finalProps.push({ key, text, primary, secondary, prop: entry.firstProp });
  });

  // 2. 关系并集
  const relMap = new Map();
  versionData.forEach((v, vi) => {
    const codeToKey = {};
    v.propositions.forEach((p) => {
      const k = normalizeText(p.text);
      codeToKey[p.prop_code] = k;
      const num = Number(String(p.prop_code).replace(/^p/, ""));
      if (!isNaN(num)) codeToKey[num] = k;
    });
    v.relations.forEach((r) => {
      const eps = (r.endpoints || [])
        .map((e) => {
          if (typeof e === "number") return codeToKey[e] || "#" + e;
          if (typeof e === "object" && e && e.relationId)
            return "R" + e.relationId;
          return String(e);
        })
        .sort();
      const key = r.type + ":" + eps.join("|");
      if (!relMap.has(key)) {
        relMap.set(key, {
          key,
          type: r.type,
          endpoints: eps,
          presentIn: new Set(),
        });
      }
      relMap.get(key).presentIn.add(vi);
    });
  });

  const finalRels = [];
  relMap.forEach((entry, key) => {
    const decision = decisionByKey["rel:" + key];
    let included = true;
    let type = entry.type;
    let endpoints = entry.endpoints;
    if (decision) {
      if (decision.mode === "reject") included = false;
      else if (decision.mode === "version")
        included = entry.presentIn.has(decision.versionIndex);
      else if (decision.mode === "relabel" || decision.mode === "expert") {
        const parsed = parseRelationValue(decision.value);
        if (parsed) {
          const mapped = parsed.endpoints
            .map((n) => {
              for (const v of versionData) {
                const p = v.propositions.find((x) => x.prop_code === "p" + n);
                if (p) return normalizeText(p.text);
              }
              return null;
            })
            .filter(Boolean);
          if (mapped.length >= 2) {
            type = parsed.type;
            endpoints = mapped.sort();
          } else {
            included = false;
          }
        }
      }
    } else {
      included = entry.presentIn.size === versionData.length;
    }
    if (!included) return;
    finalRels.push({ type, endpoints });
  });

  // 3. 写入最终版本
  const keyToCode = {};
  finalProps.forEach((p, i) => {
    keyToCode[p.key] = "p" + (i + 1);
  });

  const [ins] = await conn.query(
    `INSERT INTO annotation_versions (task_id, annotator_id, version_no, status, submitted_at)
     VALUES (?, ?, ?, 'final', NOW())`,
    [taskId, adjudicatorId, versionNo],
  );
  const finalId = ins.insertId;

  for (let i = 0; i < finalProps.length; i++) {
    const p = finalProps[i];
    const sp = p.prop || {};
    await conn.query(
      `INSERT INTO propositions
         (annotation_version_id, prop_code, text, primary_label, secondary_label, start_index, end_index, pos_x, pos_y, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finalId,
        "p" + (i + 1),
        p.text,
        p.primary || null,
        p.secondary || null,
        sp.start_index != null ? sp.start_index : null,
        sp.end_index != null ? sp.end_index : null,
        sp.pos_x != null ? sp.pos_x : 30 + (i % 3) * 20,
        sp.pos_y != null ? sp.pos_y : 20 + Math.floor(i / 3) * 20,
        i,
      ],
    );
  }

  for (let i = 0; i < finalRels.length; i++) {
    const r = finalRels[i];
    const mapped = r.endpoints
      .map((k) => {
        const code = keyToCode[k];
        return code ? Number(code.replace(/^p/, "")) : null;
      })
      .filter((n) => n !== null);
    if (mapped.length < 2) continue;
    await conn.query(
      `INSERT INTO relations (annotation_version_id, rel_code, type, endpoints, expression)
       VALUES (?, ?, ?, ?, ?)`,
      [
        finalId,
        "R" + (i + 1),
        r.type,
        JSON.stringify(mapped),
        formatExpression(r.type, mapped),
      ],
    );
  }

  return finalId;
}

module.exports = { buildFinalVersion, normalizeText };
