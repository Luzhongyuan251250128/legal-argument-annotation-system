# 法律论证标注系统

> 《软件工程与计算Ⅱ》课程小组大作业 · 第 56 组 · 南京大学 · 2026 秋

面向法学研究场景，对**裁判文书（尤其是"裁判理由"部分）**的论证结构进行结构化标注与可视化展示，
为后续自动化论证挖掘模型的训练沉淀可复用的数据集。

## 一、项目简介

系统围绕"**学生更快、更好地掌握论证框架**"这一业务需求，提供一条从数据导入到结果导出的完整标注链路：

| 阶段 | 执行角色 | 主要工作 |
| --- | --- | --- |
| 一、创建标注任务 | 特权用户 / 管理员 | 上传裁判文书、配置标签体系、分配标注任务 |
| 二、标注 | 标注员 | 命题标注、关系标注、论证图示实时生成 |
| 三、冲突解决 | 裁定者 | 人工比对多份标注结果，裁定最终版本 |
| 四、结果输出 | 特权用户 / 管理员 | 导出标注数据（Excel / JSON）与论证图示（PNG / JPG / SVG） |

流程按阶段顺序执行且不可逆。
标签体系（一级标签 SF / GF / SM / GM、二级标签 GM-L / GM-I / GM-C / GM-U / GM-M / GM-O）
与关系类型（S 支持 / A 反对 / J 组合 / M 匹配 / I 同一）详见需求文档。

## 二、文档索引

| 文档 | 说明 | 位置 |
| --- | --- | --- |
| 需求文档（按阶段组织） | 需求基线，v1.1，含各阶段待确认问题 Q1–Q18 | [`docs/requirements/requirements-by-phase.md`](docs/requirements/requirements-by-phase.md) |
| 标注与图示指南 v1.2 | 领域规范：论证结构的标注与图示标准，只读参考资料 | [`docs/reference/annotation-guideline-v1.2.pdf`](docs/reference/annotation-guideline-v1.2.pdf) |
| 界面原型 | 标注主界面的 HTML 原型 | [`prototype/index.html`](prototype/index.html) |

## 四、当前目录结构

```text
.
├─ docs/
│  ├─ requirements/         # 需求文档（Markdown，可直接 diff / 评审）
│  └─ reference/            # 领域规范、只读参考资料
├─ prototype/               # 界面原型
└─ src/                     # 项目源码（待补充）
```

## 五、原型

原型为单文件 HTML，无需构建，直接用浏览器打开即可：

```bash
start prototype/index.html      # Windows
```

## 六、约定

- 文档一律使用 **Markdown** 维护，便于评审与版本对比；需要提交 Word 版本时另行导出，不反向修改。
- 团队协作走 `main` + `dev` 分支，功能开发在 `dev` 上提交，稳定后合并回 `main`。
- 提交信息使用简洁的祈使句，例如：`docs: 补充冲突解决阶段的待确认问题`。


