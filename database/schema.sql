-- ============================================================
-- 论证标注工作台 · 生产初始化脚本
-- MySQL 8.0+ / 5.7+ (utf8mb4)
-- 内容：表结构 + 标签体系 + 唯一管理员账号
-- 不含：任务、标注版本、命题、关系、裁定、导出、教学练习、审计日志等演示数据
-- ============================================================

-- ============================================================
-- 初始管理员密码哈希（bcrypt）
-- 当前值对应明文：123456
-- 部署前请替换为新的 bcrypt 哈希，例如：
--   node -e "console.log(require('bcryptjs').hashSync('你的强密码', 10))"
-- 或将下方字符串直接换成已有的 hash 值
-- ============================================================
SET @hash_pwd = '$2a$10$aBhQPEflst0plWTRMs40quDzY/xkGi2nqGabJhosab7wH0EgMYKOS';

DROP DATABASE IF EXISTS argument_annotator;
CREATE DATABASE argument_annotator
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE argument_annotator;

-- ============================================================
-- 1. 用户表
-- ============================================================
CREATE TABLE users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username        VARCHAR(64)     NOT NULL COMMENT '登录账号',
  password_hash   VARCHAR(255)    NOT NULL COMMENT 'bcrypt 密码哈希',
  display_name    VARCHAR(64)     NOT NULL COMMENT '显示名称',
  email           VARCHAR(128)    NULL,
  phone           VARCHAR(32)     NULL,
  organization    VARCHAR(128)    NULL,
  roles           JSON            NOT NULL COMMENT '角色数组：admin/creator/annotator/adjudicator',
  teaching_role   ENUM('teacher','student') NOT NULL DEFAULT 'student',
  status          TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '1 启用 0 禁用',
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  KEY idx_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户';

-- ============================================================
-- 2. 任务（裁判文书）
-- ============================================================
CREATE TABLE tasks (
  id                          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_code                   VARCHAR(32)     NOT NULL COMMENT '业务码，如 T1',
  name                        VARCHAR(255)    NOT NULL COMMENT '文书名称',
  doc_type                    VARCHAR(16)     NOT NULL DEFAULT 'PDF' COMMENT 'PDF/DOC/TXT/文本',
  case_type                   ENUM('ordinary','guiding','reference') NOT NULL DEFAULT 'ordinary',
  detail                      VARCHAR(255)    NULL COMMENT '摘要信息',
  source_text                 MEDIUMTEXT      NULL COMMENT '文书全文',
  reason_text                 MEDIUMTEXT      NULL COMMENT '提取出的裁判理由',
  reason_start                INT             NULL COMMENT '裁判理由在全文中的起始字符位置',
  reason_end                  INT             NULL COMMENT '裁判理由在全文中的结束字符位置',
  labels_json                 JSON            NULL COMMENT '该任务创建时选定的标签快照',
  is_created                  TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '是否已创建为任务',
  annotation_submitted        TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '全部标注者是否已提交',
  adjudicated                 TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '是否已完成裁定',
  final_annotation_version_id BIGINT UNSIGNED NULL COMMENT '裁定采纳的最终标注版本',
  created_by                  BIGINT UNSIGNED NULL,
  created_at                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_tasks_code (task_code),
  KEY idx_tasks_case_type (case_type),
  KEY idx_tasks_created (is_created),
  KEY idx_tasks_adjudicated (adjudicated),
  KEY idx_tasks_created_by (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务与文书';

-- ============================================================
-- 3. 任务-标注人员
-- ============================================================
CREATE TABLE task_assignees (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  assigned_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_task_assignees (task_id, user_id),
  KEY idx_task_assignees_user (user_id),
  CONSTRAINT fk_task_assignees_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_assignees_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务标注人员分配';

-- ============================================================
-- 4. 任务-裁定者
-- 每任务至多 1 名裁定者：uk_task_adjudicators_task
-- ============================================================
CREATE TABLE task_adjudicators (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  assigned_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_task_adjudicators (task_id, user_id),
  UNIQUE KEY uk_task_adjudicators_task (task_id),
  KEY idx_task_adjudicators_user (user_id),
  CONSTRAINT fk_task_adjudicators_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_adjudicators_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务裁定者分配';

-- ============================================================
-- 5. 标签体系
-- ============================================================
CREATE TABLE labels (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(16)     NOT NULL COMMENT '标签编码，如 SF、SM-C',
  name        VARCHAR(64)     NOT NULL COMMENT '标签名称',
  parent_code VARCHAR(16)     NULL COMMENT '二级标签的父级编码',
  level       ENUM('primary','secondary') NOT NULL,
  sort_order  INT             NOT NULL DEFAULT 0,
  enabled     TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_labels_code (code),
  KEY idx_labels_parent (parent_code),
  KEY idx_labels_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='标签体系';

-- ============================================================
-- 6. 标注版本
-- ============================================================
CREATE TABLE annotation_versions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id       BIGINT UNSIGNED NOT NULL,
  annotator_id  BIGINT UNSIGNED NOT NULL,
  version_no    INT             NOT NULL DEFAULT 1,
  status        ENUM('draft','submitted','final','rejected') NOT NULL DEFAULT 'draft',
  submitted_at  DATETIME        NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_annotation_versions (task_id, annotator_id, version_no),
  KEY idx_annotation_versions_task (task_id),
  KEY idx_annotation_versions_status (status),
  CONSTRAINT fk_annotation_versions_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_annotation_versions_user FOREIGN KEY (annotator_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='标注版本';

-- ============================================================
-- 7. 命题
-- ============================================================
CREATE TABLE propositions (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  annotation_version_id  BIGINT UNSIGNED NOT NULL,
  prop_code              VARCHAR(16)     NOT NULL COMMENT '命题编号，如 p1、p2',
  text                   TEXT            NOT NULL COMMENT '命题文本',
  primary_label          VARCHAR(16)     NULL,
  secondary_label        VARCHAR(16)     NULL,
  start_index            INT             NULL COMMENT '在原文中的起始字符位置',
  end_index              INT             NULL COMMENT '在原文中的结束字符位置',
  pos_x                  DECIMAL(5,2)    NULL COMMENT '图示横坐标（0-100）',
  pos_y                  DECIMAL(5,2)    NULL COMMENT '图示纵坐标（0-100）',
  sort_order             INT             NOT NULL DEFAULT 0,
  created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_propositions_code (annotation_version_id, prop_code),
  KEY idx_propositions_version (annotation_version_id),
  CONSTRAINT fk_propositions_version FOREIGN KEY (annotation_version_id) REFERENCES annotation_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='命题';

-- ============================================================
-- 8. 关系
-- ============================================================
CREATE TABLE relations (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  annotation_version_id  BIGINT UNSIGNED NOT NULL,
  rel_code               VARCHAR(16)     NOT NULL COMMENT '关系编号，如 R1、R2',
  type                   CHAR(1)         NOT NULL COMMENT 'S 支持 / A 反对 / M 匹配 / J 组合 / I 同一',
  endpoints              JSON            NOT NULL COMMENT '关系端点数组，如 [1, 3]',
  expression             VARCHAR(512)    NULL COMMENT '冗余表达式，如 S(p1, p3)',
  created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_relations_code (annotation_version_id, rel_code),
  KEY idx_relations_version (annotation_version_id),
  CONSTRAINT fk_relations_version FOREIGN KEY (annotation_version_id) REFERENCES annotation_versions(id) ON DELETE CASCADE,
  CONSTRAINT chk_relations_type CHECK (type IN ('S','A','M','J','I'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='命题关系';

-- ============================================================
-- 9. 裁定结果
-- ============================================================
CREATE TABLE adjudications (
  id                          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id                     BIGINT UNSIGNED NOT NULL,
  adjudicator_id              BIGINT UNSIGNED NOT NULL,
  label_decision              VARCHAR(64)     NULL COMMENT '标签差异的裁定结论',
  relation_decision           VARCHAR(128)    NULL COMMENT '关系差异的裁定结论',
  decisions_json              JSON            NULL COMMENT '完整裁定决策数据',
  final_annotation_version_id BIGINT UNSIGNED NULL COMMENT '本次裁定采纳的最终版本',
  decided_at                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_adjudications_task_user (task_id, adjudicator_id),
  KEY idx_adjudications_task (task_id),
  KEY idx_adjudications_user (adjudicator_id),
  CONSTRAINT fk_adjudications_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_adjudications_user FOREIGN KEY (adjudicator_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='裁定结果';

-- ============================================================
-- 10. 导出记录
-- ============================================================
CREATE TABLE exports (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id            BIGINT UNSIGNED NOT NULL,
  filename           VARCHAR(255)    NOT NULL,
  format             VARCHAR(16)     NOT NULL DEFAULT 'JSON' COMMENT 'JSON/Excel/SVG',
  guideline_version  VARCHAR(16)     NULL,
  download_url       VARCHAR(512)    NULL,
  created_by         BIGINT UNSIGNED NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_exports_task (task_id),
  KEY idx_exports_creator (created_by),
  CONSTRAINT fk_exports_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='导出记录';

-- ============================================================
-- 11. 教学练习
-- ============================================================
CREATE TABLE teaching_practices (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title                     VARCHAR(128)    NOT NULL,
  description               TEXT            NULL,
  source_text               MEDIUMTEXT      NULL COMMENT '练习原文',
  standard_annotation_json  JSON            NULL COMMENT '标准答案（命题 + 关系）',
  published_by              BIGINT UNSIGNED NULL,
  published_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_teaching_practices_publisher (published_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='教学练习';

-- ============================================================
-- 12. 操作日志（可选）
-- ============================================================
CREATE TABLE audit_logs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NULL,
  action       VARCHAR(64)     NOT NULL COMMENT '动作名，如 task.assign',
  entity_type  VARCHAR(32)     NULL COMMENT '关联实体类型',
  entity_id    BIGINT UNSIGNED NULL COMMENT '关联实体 ID',
  payload      JSON            NULL COMMENT '附加信息',
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_user (user_id),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志';

-- ============================================================
-- 13. 标签体系（保留现有全部标签）
--     关系类型 S/A/M/J/I 由 relations 表的 CHECK 约束定义，无需数据行
-- ============================================================
INSERT INTO labels (code, name, parent_code, level, sort_order, enabled) VALUES
  ('SF',   '个别事实判断',   NULL, 'primary',   10, 1),
  ('GF',   '一般事实判断',   NULL, 'primary',   20, 1),
  ('SM',   '个别规范判断',   NULL, 'primary',   30, 1),
  ('GM',   '一般规范判断',   NULL, 'primary',   40, 1),
  ('GM-L', '法律条文',       'GM', 'secondary', 11, 1),
  ('GM-I', '法律解释',       'GM', 'secondary', 12, 1),
  ('GM-U', '习惯与行业惯例', 'GM', 'secondary', 13, 1),
  ('GM-M', '道德与价值观念', 'GM', 'secondary', 14, 1),
  ('GM-O', '其他规范判断',   'GM', 'secondary', 15, 1),
  ('SM-C', '合同及合同解释', 'SM', 'secondary', 31, 1);

-- ============================================================
-- 14. 唯一管理员账号
--     账号：admin
--     密码：由文件开头 @hash_pwd 决定（默认值对应明文 123456）
--     部署后请立即通过「个人信息 → 修改密码」改为强密码
-- ============================================================
INSERT INTO users
  (username, password_hash, display_name, email, phone, organization, roles, teaching_role)
VALUES
  ('admin',
   @hash_pwd,
   '系统管理员',
   NULL,
   NULL,
   '系统',
   JSON_ARRAY('admin','creator'),
   'teacher');