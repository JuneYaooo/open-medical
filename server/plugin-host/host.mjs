import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../errors.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
import { definePlugin } from "./define.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const DEFAULT_PLUGIN_DIRS = [resolve(ROOT, "plugins")];

const IDENT = [
  '"([^"]+)"',
  "'([^']+)'",
  "`([^`]+)`",
  "\\[([^\\]]+)\\]",
  "([A-Za-z_][A-Za-z0-9_$]*)",
].join("|");

const stripSqlComments = (sql) =>
  String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");

const firstIdentifier = (match, from = 1) =>
  match.slice(from).find((value) => value !== undefined);

// Migrations may only create/alter tables under the plugin's own prefix. The
// parser is deliberately conservative (CREATE TABLE / ALTER TABLE / CREATE
// INDEX ... ON) and accepts quoted identifiers; it is not a full SQL parser.
export function validateMigrationSql(sql, tablePrefix) {
  const prefixes = Array.isArray(tablePrefix) ? tablePrefix : [tablePrefix];
  check(
    prefixes.length > 0 &&
      prefixes.every((prefix) => typeof prefix === "string" && prefix),
    "PLUGIN_MIGRATION",
    "插件迁移缺少 tablePrefix",
  );
  const source = stripSqlComments(sql);
  const names = [];
  const createTable = new RegExp(
    `\\bCREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT})`,
    "gi",
  );
  for (const match of source.matchAll(createTable))
    names.push({ statement: "CREATE TABLE", name: firstIdentifier(match) });

  const alterTable = new RegExp(
    `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:${IDENT})`,
    "gi",
  );
  for (const match of source.matchAll(alterTable))
    names.push({ statement: "ALTER TABLE", name: firstIdentifier(match) });

  const createIndex = new RegExp(
    `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT})\\s+ON\\s+(?:${IDENT})`,
    "gi",
  );
  for (const match of source.matchAll(createIndex))
    names.push({
      statement: "CREATE INDEX",
      name: firstIdentifier(match, 6),
    });

  for (const { statement, name } of names) {
    check(
      typeof name === "string" &&
        prefixes.some((prefix) => name.startsWith(prefix)),
      "PLUGIN_MIGRATION",
      `${statement} 的表名 ${name || "(无法识别)"} 必须以 ${prefixes.join(" / ")} 开头`,
    );
  }
  return names.map((item) => item.name);
}

const errorMessage = (error) =>
  String(error?.message || error || "未知错误").slice(0, 1000);

const VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/;

function parseVersion(value) {
  const match = VERSION.exec(String(value || "").trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function bumpVersion(version, index) {
  const next = [...version];
  next[index] += 1;
  for (let cursor = index + 1; cursor < next.length; cursor += 1) next[cursor] = 0;
  return next;
}

// Small, dependency-free semver range support for plugin compatibility. It
// covers the forms used by plugin manifests: "*", exact versions, comparators,
// caret and tilde ranges, and space-separated comparator sets.
export function satisfiesVersion(version, range = "*") {
  const current = parseVersion(version);
  if (!current) return false;
  const raw = String(range || "*").trim();
  if (!raw || raw === "*" || raw === "x") return true;
  return raw.split("||").some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((token) => {
        if (token === "*" || token === "x") return true;
        let operator = "=";
        let value = token;
        for (const candidate of [">=", "<=", ">", "<", "=", "^", "~"]) {
          if (token.startsWith(candidate)) {
            operator = candidate;
            value = token.slice(candidate.length);
            break;
          }
        }
        const wanted = parseVersion(value);
        if (!wanted) return false;
        if (operator === "=") return compareVersions(current, wanted) === 0;
        if (operator === ">") return compareVersions(current, wanted) > 0;
        if (operator === ">=") return compareVersions(current, wanted) >= 0;
        if (operator === "<") return compareVersions(current, wanted) < 0;
        if (operator === "<=") return compareVersions(current, wanted) <= 0;
        if (operator === "^") {
          const upper = wanted[0] > 0
            ? bumpVersion(wanted, 0)
            : wanted[1] > 0
              ? bumpVersion(wanted, 1)
              : bumpVersion(wanted, 2);
          return (
            compareVersions(current, wanted) >= 0 &&
            compareVersions(current, upper) < 0
          );
        }
        const upper = bumpVersion(wanted, 1);
        return (
          compareVersions(current, wanted) >= 0 &&
          compareVersions(current, upper) < 0
        );
      }),
  );
}

function patternSegments(path) {
  return path.split("/").filter(Boolean);
}

export function matchLegacyPath(pattern, pathname) {
  const expected = patternSegments(pattern);
  const actual = patternSegments(pathname);
  const params = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    if (segment === "*") {
      params.rest = actual.slice(index).join("/");
      return index < actual.length || expected.length === index + 1
        ? params
        : null;
    }
    if (index >= actual.length) return null;
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      const value = actual[index];
      if (!value) return null;
      params[name] = decodeURIComponent(value);
      continue;
    }
    if (segment !== actual[index]) return null;
  }
  return expected.length === actual.length ? params : null;
}

function legacyPathRank(path) {
  const segments = patternSegments(path);
  if (segments.includes("*")) return 0;
  if (segments.some((segment) => segment.startsWith(":"))) return 1;
  return 2;
}

function withTimeout(promise, timeoutMs, description) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${description}超时（${timeoutMs}ms）`)),
      timeoutMs,
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

export class PluginHost {
  constructor({
    db,
    store = null,
    services = {},
    pluginDirs,
    enabled = {},
  } = {}) {
    check(db, "PLUGIN_HOST", "PluginHost 需要数据库连接");
    this.db = db;
    this.store = store;
    this.baseServices = services;
    const dirs = Array.isArray(pluginDirs)
      ? pluginDirs
      : pluginDirs
        ? [pluginDirs]
        : DEFAULT_PLUGIN_DIRS;
    this.pluginDirs = dirs.map((dir) => resolve(dir));
    this.initialEnabled = enabled || {};
    this.records = [];
    this.ordered = [];
    this.byId = new Map();
    this.pluginServices = {};
    this.providedServices = new Map();
    this.listeners = new Map();
    this.hookListeners = new Map();
    this.legacyRoutes = [];
    this.statusCache = new Map();
    this.startedPlugins = new Set();
    this.drainedPlugins = new Set();
    this.lifecycleStates = new Map();
    this.lifecycleErrors = new Map();
    this.loaded = false;
    this._ensureTables();
  }

  _ensureTables() {
    // An install with plugin migrations or patients predates this boot. Used
    // by keepEnabledOnUpgrade: plugins that became off-by-default stay on for
    // existing users instead of silently disappearing.
    // Databases from before the plugin host have no migration rows but do
    // have patients, so either signal counts.
    const hasRows = (table) =>
      Boolean(
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
          this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get(),
      );
    this.upgradedInstall = hasRows("plugin_migrations") || hasRows("patients");
    this.db.exec(`CREATE TABLE IF NOT EXISTS plugin_state (
      plugin_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugin_migrations (
      plugin_id TEXT NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY(plugin_id, name)
    );
    CREATE TABLE IF NOT EXISTS plugin_config (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(plugin_id, key)
    );`);
  }

  _stateEnabled(spec) {
    const row = this.db
      .prepare("SELECT enabled FROM plugin_state WHERE plugin_id=?")
      .get(spec.id);
    if (row) return row.enabled === 1;
    if (Object.hasOwn(this.initialEnabled, spec.id))
      return this.initialEnabled[spec.id] === true;
    if (spec.keepEnabledOnUpgrade && !spec.enabledByDefault) {
      // Decide once and persist, so a fresh install stays off after its
      // first boot has written migration rows.
      const enabled = this.upgradedInstall;
      this.db
        .prepare("INSERT OR IGNORE INTO plugin_state(plugin_id,enabled,updated_at) VALUES (?,?,?)")
        .run(spec.id, enabled ? 1 : 0, new Date().toISOString());
      return enabled;
    }
    return spec.enabledByDefault;
  }

  load() {
    this.records = [];
    this.ordered = [];
    this.byId = new Map();
    this.pluginServices = {};
    this.providedServices = new Map();
    this.listeners = new Map();
    this.hookListeners = new Map();
    this.legacyRoutes = [];
    this.statusCache = new Map();
    this.startedPlugins = new Set();
    this.drainedPlugins = new Set();
    this.lifecycleStates = new Map();
    this.lifecycleErrors = new Map();
    for (const directory of this.pluginDirs) {
      if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
      // A pluginDir may be either a plugins/ container or one plugin folder;
      // supporting both keeps fixtures and production wiring identical.
      const candidates = [];
      if (existsSync(join(directory, "plugin.mjs")))
        candidates.push({ name: basename(directory), dir: directory });
      else {
        const entries = readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const pluginDir = join(directory, entry.name);
          if (existsSync(join(pluginDir, "plugin.mjs")))
            candidates.push({ name: entry.name, dir: pluginDir });
        }
      }
      for (const entry of candidates) {
        const pluginDir = entry.dir;
        const pluginFile = join(pluginDir, "plugin.mjs");
        const record = {
          id: entry.name,
          dir: pluginDir,
          spec: null,
          enabled: false,
          available: false,
          reason: "",
          promptText: "",
        };
        try {
          const loaded = require(pluginFile);
          const raw = loaded?.default ?? loaded;
          const spec = definePlugin(raw);
          record.id = spec.id;
          record.spec = spec;
          record.enabled = this._stateEnabled(spec);
          if (this.byId.has(spec.id)) {
            record.reason = `插件 id 重复：${spec.id}`;
          } else {
            if (spec.prompt) {
              const promptFile = resolve(pluginDir, spec.prompt);
              check(
                existsSync(promptFile) && statSync(promptFile).isFile(),
                "PLUGIN_PROMPT",
                `提示文件不存在：${spec.prompt}`,
              );
              record.promptText = readFileSync(promptFile, "utf8");
            }
            if (spec.skills) {
              const skillsDir = resolve(pluginDir, spec.skills);
              check(
                existsSync(skillsDir) && statSync(skillsDir).isDirectory(),
                "PLUGIN_SKILLS",
                `技能目录不存在：${spec.skills}`,
              );
            }
            if (spec.migrations) {
              const migrationDir = resolve(pluginDir, spec.migrations);
              check(
                existsSync(migrationDir) && statSync(migrationDir).isDirectory(),
                "PLUGIN_MIGRATION",
                `迁移目录不存在：${spec.migrations}`,
              );
            }
            record.available = true;
          }
        } catch (error) {
          record.available = false;
          record.reason = `加载失败：${errorMessage(error)}`;
        }
        this.records.push(record);
        if (record.spec && !this.byId.has(record.id))
          this.byId.set(record.id, record);
      }
    }
    this._resolveDependencies();
    this._order();
    this.loaded = true;
    return this.list();
  }

  _resolveDependencies() {
    const resolveRecord = (record, trail) => {
      if (record._resolved !== undefined) return record._resolved;
      if (!record.available) {
        record._resolved = false;
        return false;
      }
      if (record._visiting) {
        record.available = false;
        record.reason = `依赖存在环：${[...trail, record.id].join(" -> ")}`;
        record._resolved = false;
        return false;
      }
      record._visiting = true;
      let failure = "";
      if (record.enabled && record.spec) {
        for (const [dependency, range] of Object.entries(
          record.spec.requires.plugins,
        )) {
          const target = this.byId.get(dependency);
          if (!target) {
            failure = `缺少依赖插件 ${dependency}${range ? `@${range}` : ""}`;
            break;
          }
          if (!target.enabled) {
            failure = `依赖插件 ${dependency} 未启用`;
            break;
          }
          if (!satisfiesVersion(target.spec?.version, range)) {
            failure = `依赖插件 ${dependency} 版本 ${target.spec?.version || "未知"} 不满足 ${range}`;
            break;
          }
          if (target._visiting) {
            failure = `依赖存在环：${[...trail, record.id, dependency].join(" -> ")}`;
            break;
          }
          if (!resolveRecord(target, [...trail, record.id])) {
            failure = /依赖存在环/.test(target.reason)
              ? target.reason
              : `依赖插件 ${dependency} 不可用`;
            break;
          }
        }
        if (!failure && record.spec.requires.anyOf.length) {
          // Each group is an OR, and groups are ANDed together. This mirrors
          // the manifest contract: [[a,b],[c]] means (a or b) and c.
          const groups = record.spec.requires.anyOf;
          for (const group of groups) {
            const satisfied = group.some((dependency) => {
              const target = this.byId.get(dependency);
              return Boolean(
                target &&
                  target.enabled &&
                  resolveRecord(target, [...trail, record.id]),
              );
            });
            if (!satisfied) {
              failure = groups.length === 1
                ? `需要启用以下插件之一：${group.join(" / ")}`
                : `需要同时满足以下插件组：${groups
                    .map((item) => `(${item.join(" / ")})`)
                    .join(" 且 ")}`;
              break;
            }
          }
        }
      }
      record._visiting = false;
      if (failure) {
        record.available = false;
        record.reason = failure;
      }
      record._resolved = record.available;
      return record._resolved;
    };
    for (const record of this.records) resolveRecord(record, []);
    for (const record of this.records) delete record._resolved;
  }

  _startupDependencies(record) {
    if (!record.spec) return [];
    const dependencies = Object.keys(record.spec.requires.plugins);
    // One satisfier per group participates in start ordering; every group is
    // required, so flattening would let the first group mask the others.
    for (const group of record.spec.requires.anyOf) {
      const target = group
        .map((id) => this.byId.get(id))
        .find(
          (candidate) => candidate && candidate.enabled && candidate.available,
        );
      if (target) dependencies.push(target.id);
    }
    return [...new Set(dependencies)];
  }

  _order() {
    const ordered = [];
    const seen = new Set();
    const visit = (record) => {
      if (seen.has(record.id)) return;
      seen.add(record.id);
      if (record.enabled && record.spec)
        for (const dependency of this._startupDependencies(record)) {
          const target = this.byId.get(dependency);
          if (target) visit(target);
        }
      ordered.push(record);
    };
    for (const record of [...this.records].sort((a, b) =>
      a.id.localeCompare(b.id),
    ))
      visit(record);
    this.ordered = ordered;
  }

  _buildLegacyRoutes() {
    const buckets = new Map();
    for (const record of this.ordered) {
      if (!record.available || !record.enabled || !record.spec) continue;
      for (const route of record.spec.legacyApiPaths) {
        const key = `${route.method} ${route.path}`;
        const list = buckets.get(key) || [];
        list.push(record);
        buckets.set(key, list);
      }
    }
    const conflicts = new Map();
    for (const [key, records] of buckets) {
      const unique = [...new Set(records)];
      if (unique.length < 2) continue;
      for (const record of unique)
        conflicts.set(
          record,
          `legacy API 路由冲突：${key} 同时由 ${unique
            .map((item) => item.id)
            .join(" / ")} 声明`,
        );
    }
    for (const [record, reason] of conflicts) this._fail(record, reason);

    const routes = [];
    for (const record of this.ordered) {
      if (!record.available || !record.enabled || !record.spec) continue;
      for (const route of record.spec.legacyApiPaths)
        routes.push({
          record,
          method: route.method,
          path: route.path,
          rank: legacyPathRank(route.path),
        });
    }
    routes.sort(
      (a, b) =>
        b.rank - a.rank ||
        (a.method === "*" ? 1 : 0) - (b.method === "*" ? 1 : 0) ||
        a.record.id.localeCompare(b.record.id) ||
        a.path.localeCompare(b.path),
    );
    this.legacyRoutes = routes;
    return routes;
  }

  _fail(record, reason) {
    record.available = false;
    record.reason = reason;
    if (record.spec) {
      delete this.pluginServices[record.spec.id];
      for (const [serviceId, entry] of this.providedServices) {
        if (entry.pluginId === record.spec.id)
          this.providedServices.delete(serviceId);
      }
    }
  }

  migrate() {
    for (const record of this.ordered) {
      if (!record.available || !record.spec?.migrations) continue;
      const spec = record.spec;
      try {
        const migrationDir = resolve(record.dir, spec.migrations);
        const files = readdirSync(migrationDir)
          .filter((name) => name.endsWith(".sql"))
          .sort((a, b) => a.localeCompare(b));
        for (const name of files) {
          const applied = this.db
            .prepare(
              "SELECT 1 FROM plugin_migrations WHERE plugin_id=? AND name=?",
            )
            .get(spec.id, name);
          if (applied) continue;
          const sql = readFileSync(join(migrationDir, name), "utf8");
          validateMigrationSql(sql, spec.tablePrefix);
          sqliteTransaction(this.db, () => {
            this.db.exec(sql);
            this.db
              .prepare(
                "INSERT INTO plugin_migrations(plugin_id,name,applied_at) VALUES (?,?,?)",
              )
              .run(spec.id, name, new Date().toISOString());
          });
        }
      } catch (error) {
        this._fail(record, `迁移失败：${errorMessage(error)}`);
      }
    }
  }

  setup() {
    // Route conflicts are detected before any setup side effect: a conflicting
    // plugin becomes unavailable while the rest of the server keeps running.
    this._buildLegacyRoutes();
    for (const record of this.ordered) {
      if (!record.available || !record.spec) continue;
      if (record.enabled) {
        const missing = Object.keys(record.spec.requires.plugins).find(
          (dependency) => {
            const target = this.byId.get(dependency);
            if (!target || !target.enabled || !target.available) return true;
            return !satisfiesVersion(
              target.spec?.version,
              record.spec.requires.plugins[dependency],
            );
          },
        );
        if (missing) {
          this._fail(record, `依赖插件 ${missing} 不可用`);
          continue;
        }
        const groups = record.spec.requires.anyOf;
        const unsatisfied = groups.find(
          (group) =>
            !group.some((dependency) => {
              const target = this.byId.get(dependency);
              return target && target.enabled && target.available;
            }),
        );
        if (unsatisfied) {
          this._fail(
            record,
            groups.length === 1
              ? `需要启用以下插件之一：${unsatisfied.join(" / ")}`
              : `需要同时满足以下插件组：${groups
                  .map((item) => `(${item.join(" / ")})`)
                  .join(" 且 ")}`,
          );
          continue;
        }
      }
      try {
        const service = record.spec.setup
          ? record.spec.setup(this.contextFor(record))
          : undefined;
        if (service !== undefined) this.pluginServices[record.spec.id] = service;
        if (record.spec.provides) {
          const provided = record.spec.provides;
          check(
            service !== undefined,
            "PLUGIN_SPEC",
            `插件 ${record.id} 声明 provides.service=${provided.service} 但 setup 未返回服务`,
          );
          const existing = this.providedServices.get(provided.service);
          check(
            !existing || existing.pluginId === record.id,
            "PLUGIN_SPEC",
            `服务 ${provided.service} 同时由 ${existing?.pluginId} 与 ${record.id} 提供`,
          );
          this.providedServices.set(provided.service, {
            pluginId: record.id,
            apiVersion: provided.apiVersion,
            service,
          });
        }
        if (record.spec.events)
          for (const [name, listener] of Object.entries(record.spec.events)) {
            const list = this.listeners.get(name) || [];
            list.push((payload) =>
              listener(payload, this.contextFor(record)),
            );
            this.listeners.set(name, list);
          }
        if (record.spec.hooks)
          for (const [name, listener] of Object.entries(record.spec.hooks)) {
            const list = this.hookListeners.get(name) || [];
            list.push({
              pluginId: record.id,
              listener: (payload) =>
                listener(payload, this.contextFor(record)),
            });
            this.hookListeners.set(name, list);
          }
      } catch (error) {
        this._fail(record, `初始化失败：${errorMessage(error)}`);
      }
    }
    // Failure while wiring a later plugin must not leave its routes active.
    this._buildLegacyRoutes();
    return this.list();
  }

  _services() {
    return { ...this.baseServices, ...this.pluginServices };
  }

  resolveService(id, options = {}) {
    const { apiVersion } =
      typeof options === "number" ? { apiVersion: options } : options || {};
    const entry = this.providedServices.get(id);
    check(
      entry,
      "PLUGIN_SERVICE_UNAVAILABLE",
      `插件服务 ${id || "(未指定)"} 不存在或未提供`,
      503,
    );
    const target = this.byId.get(entry.pluginId);
    check(
      target?.available && target?.enabled,
      "PLUGIN_SERVICE_UNAVAILABLE",
      `插件服务 ${id} 所属插件 ${entry.pluginId} 不可用或未启用`,
      503,
    );
    if (apiVersion !== undefined)
      check(
        entry.apiVersion === apiVersion,
        "PLUGIN_SERVICE_VERSION",
        `插件服务 ${id} 的版本为 ${entry.apiVersion}，需要 ${apiVersion}`,
        409,
      );
    return entry.service;
  }

  contextFor(record) {
    const appendReason = (error) => {
      this._fail(record, `运行时错误：${errorMessage(error)}`);
    };
    const plugins = {};
    for (const entry of this.providedServices.values()) {
      const target = this.byId.get(entry.pluginId);
      plugins[entry.pluginId] = Object.freeze({
        id: entry.pluginId,
        service: entry.service,
        apiVersion: entry.apiVersion,
        available: Boolean(target?.available),
        enabled: Boolean(target?.enabled),
      });
    }
    return Object.freeze({
      db: this.db,
      store: this.store,
      services: this._services(),
      service: (id, options) => this.resolveService(id, options),
      plugins: Object.freeze(plugins),
      events: Object.freeze({
        emit: (name, payload) => this.emit(name, payload),
        on: (name, listener) => this.on(name, listener),
      }),
      now: () => new Date().toISOString(),
      log: (...args) => console.log(`[plugin:${record.id}]`, ...args),
      config: Object.freeze({
        get: (key) => this.getConfig(record.id, key),
        set: (key, value) => this.setConfig(record.id, key, value),
      }),
      proposals: Object.freeze({
        create: (proposal) => this.createProposal(record, proposal),
      }),
      plugin: Object.freeze({ id: record.id, dir: record.dir }),
      fail: appendReason,
    });
  }

  getConfig(pluginId, key) {
    const row = this.db
      .prepare("SELECT value FROM plugin_config WHERE plugin_id=? AND key=?")
      .get(pluginId, String(key));
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  setConfig(pluginId, key, value) {
    this.db
      .prepare(
        `INSERT INTO plugin_config(plugin_id,key,value,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      )
      .run(pluginId, String(key), JSON.stringify(value), new Date().toISOString());
    return value;
  }

  createProposal(record, { kind, patientId, input, summary } = {}) {
    const legacy = record?.spec?.legacyProposalTypes?.[kind];
    check(
      record?.spec?.proposals?.[kind] || legacy,
      "PLUGIN_PROPOSAL",
      `插件 ${record?.id || ""} 未定义提案类型 ${kind || ""}`,
    );
    const pending = this.baseServices.pending;
    check(
      pending && typeof pending.propose === "function",
      "PLUGIN_PENDING_UNAVAILABLE",
      "提案机制不可用",
      503,
    );
    return pending.propose({
      type: kind,
      patientId,
      // Historical types keep their original top-level payload shape; new
      // plugin proposals keep the { input } envelope.
      payload: legacy ? input : { input },
      summary: summary || `${record.spec.title}提案`,
    });
  }


  // Transactional hook bus for work that must share the caller's SQLite
  // transaction. Unlike emit(), the first listener error is re-thrown so the
  // fixed region can roll back every participant. Hooks are registered for
  // every available plugin (including disabled ones): deleting a patient is a
  // fixed-region housekeeping operation, and stale plugin rows would otherwise
  // survive a temporarily disabled feature.
  runHooks(name, payload) {
    for (const entry of this.hookListeners.get(name) || []) {
      try {
        entry.listener(payload);
      } catch (error) {
        if (error && typeof error === "object" && !error.pluginId)
          error.pluginId = entry.pluginId;
        throw error;
      }
    }
  }

  // Patient-list count contributions. Each active plugin may return an object
  // keyed by patient id; the fixed region merges only the fields it owns, so a
  // disabled or missing plugin leaves the historical empty values in place.
  patientSummaries(patientIds = [], options = {}) {
    const merged = {};
    for (const record of this.ordered) {
      if (!this._isActive(record) || !record.spec?.patientSummary) continue;
      try {
        const value = record.spec.patientSummary(
          this.contextFor(record),
          patientIds,
          options,
        );
        if (!value || typeof value !== "object" || Array.isArray(value))
          continue;
        for (const [patientId, fields] of Object.entries(value)) {
          if (!fields || typeof fields !== "object" || Array.isArray(fields))
            continue;
          merged[patientId] = { ...(merged[patientId] || {}), ...fields };
        }
      } catch (error) {
        console.error(`插件 ${record.id} 患者计数贡献失败:`, error);
      }
    }
    return merged;
  }

  // Patient-brief contributions. Plugins return only their own fields; the
  // fixed region supplies the empty defaults when no active plugin answers.
  patientBrief(patientId) {
    const merged = {};
    for (const record of this.ordered) {
      if (!this._isActive(record) || !record.spec?.patientBrief) continue;
      try {
        const value = record.spec.patientBrief(
          this.contextFor(record),
          patientId,
        );
        if (!value || typeof value !== "object" || Array.isArray(value))
          continue;
        Object.assign(merged, value);
      } catch (error) {
        console.error(`插件 ${record.id} 患者简报贡献失败:`, error);
      }
    }
    return merged;
  }

  // Demo-pack contributions. Installation only runs for active plugins, while
  // clear/exists also cover temporarily disabled plugins so their historical
  // demo rows stay visible and removable.
  async demoInstall(demo) {
    for (const record of this.ordered) {
      if (!this._isActive(record) || !record.spec?.demo?.install) continue;
      await record.spec.demo.install(this.contextFor(record), demo);
    }
  }

  async demoClear(demo) {
    for (const record of this.ordered) {
      if (!record.available || !record.spec?.demo?.clear) continue;
      await record.spec.demo.clear(this.contextFor(record), demo);
    }
  }

  demoExists(kind, id, demo) {
    for (const record of this.ordered) {
      if (!record.available || !record.spec?.demo?.exists) continue;
      try {
        if (record.spec.demo.exists(this.contextFor(record), kind, id, demo))
          return true;
      } catch (error) {
        console.error(`插件 ${record.id} 示例资源检查失败:`, error);
      }
    }
    return false;
  }

  emit(name, payload) {
    for (const listener of this.listeners.get(name) || []) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`插件事件 ${name} 处理失败:`, error);
      }
    }
  }

  on(name, listener) {
    check(typeof listener === "function", "PLUGIN_EVENT", "事件监听器必须是函数");
    const list = this.listeners.get(name) || [];
    list.push(listener);
    this.listeners.set(name, list);
    return () => {
      const current = this.listeners.get(name) || [];
      this.listeners.set(
        name,
        current.filter((item) => item !== listener),
      );
    };
  }

  // Verification hooks run at the domain's beforeComplete seam. The plugin
  // decides from the run policy whether it applies; disabled plugins are
  // skipped entirely because _isActive() is false.
  beforeComplete(args) {
    for (const record of this.ordered) {
      if (!this._isActive(record) || !record.spec?.workflows) continue;
      for (const hooks of Object.values(record.spec.workflows)) {
        if (typeof hooks.beforeComplete !== "function") continue;
        hooks.beforeComplete(this.contextFor(record), args);
      }
    }
  }

  registerTools(registry, workspace, run = null) {
    for (const record of this.ordered) {
      if (!this._isActive(record) || !record.spec?.tools) continue;
      try {
        const result = record.spec.tools(this.contextFor(record), {
          registry,
          workspace,
          run,
        });
        if (result && typeof result.catch === "function")
          result.catch((error) =>
            this._fail(record, `工具注册失败：${errorMessage(error)}`),
          );
      } catch (error) {
        this._fail(record, `工具注册失败：${errorMessage(error)}`);
      }
    }
  }

  promptFragments() {
    return this.ordered
      .filter(
        (record) =>
          this._isActive(record) &&
          record.promptText.trim() &&
          this._promptWanted(record),
      )
      .map((record) => record.promptText.trim())
      .join("\n\n");
  }

  // A plugin can hide its prompt while it has nothing usable to offer (for
  // example a channel that is not configured). A failing check keeps it.
  _promptWanted(record) {
    if (!record.spec?.promptWhen) return true;
    try {
      return record.spec.promptWhen(this.contextFor(record)) !== false;
    } catch {
      return true;
    }
  }

  skillDirs() {
    return this.ordered
      .filter(
        (record) => this._isActive(record) && record.spec?.skills,
      )
      .map((record) => resolve(record.dir, record.spec.skills))
      .filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
  }

  proposalHandler(kind) {
    if (typeof kind !== "string") return null;
    for (const record of this.ordered) {
      if (!record.available || !record.enabled) continue;
      const direct = record.spec?.proposals?.[kind];
      const legacy = direct ? null : record.spec?.legacyProposalTypes?.[kind];
      const handler = direct || legacy;
      if (!handler) continue;
      return {
        pluginId: record.id,
        legacy: Boolean(legacy),
        revisionScoped: handler.revisionScoped === true,
        validate: (input, meta) =>
          handler.validate
            ? handler.validate(input, this.contextFor(record), meta)
            : input,
        apply: (input, tx, meta) =>
          handler.apply(input, this.contextFor(record), tx ?? this.db, meta),
      };
    }
    return null;
  }

  // Listing historical proposals must keep working while their plugin is
  // disabled or unavailable. Confirmation still goes through proposalHandler,
  // which only resolves enabled plugins and therefore yields PLUGIN_UNAVAILABLE.
  knowsProposalType(kind) {
    if (typeof kind !== "string") return false;
    return this.records.some(
      (record) =>
        record.spec?.proposals?.[kind] !== undefined ||
        record.spec?.legacyProposalTypes?.[kind] !== undefined,
    );
  }

  // Workflow hooks are only exposed while the owning plugin is enabled. The
  // returned object carries the plugin context so callers can invoke
  // configure(ctx, { registry, workspace, run }) exactly as plugins declare it.
  workflow(id) {
    for (const record of this.ordered) {
      if (!record.available || !record.enabled || !record.spec) continue;
      const hooks = record.spec.workflows?.[id];
      if (!hooks) continue;
      return Object.freeze({
        id,
        pluginId: record.id,
        artifactType: hooks.artifactType,
        ctx: this.contextFor(record),
        detect: hooks.detect,
        applyPolicy: hooks.applyPolicy,
        guidance: hooks.guidance,
        configure: hooks.configure,
        prepared: hooks.prepared,
        beforeComplete: hooks.beforeComplete,
        answer: hooks.answer,
      });
    }
    return null;
  }

  // Task context kinds declared by plugins. Like matchWorkflow, a disabled
  // plugin's kind is still recognised so the request fails with
  // PLUGIN_UNAVAILABLE instead of "unknown kind"; hooks are only callable while
  // the plugin is enabled.
  taskContext(kind) {
    for (const record of this.ordered) {
      const hooks = record.spec?.contexts?.[kind];
      if (!hooks) continue;
      const enabled = Boolean(record.enabled && record.available);
      const ctx = enabled ? this.contextFor(record) : null;
      return Object.freeze({
        kind,
        pluginId: record.id,
        enabled,
        workflow: hooks.workflow,
        sticky: hooks.sticky === true,
        validate: enabled && hooks.validate ? (context) => hooks.validate(ctx, context) : undefined,
        guidance: enabled ? (context) => hooks.guidance(ctx, context) : undefined,
      });
    }
    return null;
  }

  // Detection is intentionally available for disabled plugins so a request can
  // fail with PLUGIN_UNAVAILABLE instead of silently running the wrong
  // workflow. Callers must use workflow(id) before invoking any hook.
  matchWorkflow(message, policy) {
    for (const record of this.ordered) {
      if (!record.spec?.workflows) continue;
      for (const [id, hooks] of Object.entries(record.spec.workflows)) {
        if (!hooks.detect) continue;
        let matched = false;
        try {
          matched = hooks.detect(message, policy) === true;
        } catch (error) {
          this._fail(record, `工作流检测失败：${errorMessage(error)}`);
        }
        if (matched)
          return {
            id,
            pluginId: record.id,
            enabled: record.enabled && record.available,
            available: record.available,
            workflow: record.enabled && record.available ? this.workflow(id) : null,
          };
      }
    }
    return null;
  }

  // Metadata for the agenda shell: only enabled, available plugin sources are
  // advertised, so a kind filter can be validated against the same set the
  // reader will actually use.
  agendaSources() {
    const sources = [];
    for (const record of this.ordered) {
      if (!this._isActive(record) || !record.spec) continue;
      for (const source of record.spec.agendaSources) {
        if (!this._sourceAvailable(record, source)) continue;
        sources.push({
          pluginId: record.id,
          kind: source.kind,
          label: source.label,
          order: source.order,
        });
      }
    }
    return sources.sort(
      (a, b) =>
        a.order - b.order ||
        a.pluginId.localeCompare(b.pluginId) ||
        a.kind.localeCompare(b.kind),
    );
  }

  // An agenda source may depend on runtime state inside an active plugin
  // (for example patient messages need a connected channel). A source whose
  // available(ctx) is false is hidden from both the kind list and the items.
  _sourceAvailable(record, source) {
    if (typeof source.available !== "function") return true;
    try {
      return source.available(this.contextFor(record)) !== false;
    } catch (error) {
      console.error(`插件 ${record.id} 待办来源可用性检查失败:`, error);
      return false;
    }
  }

  agendaItems({
    now = new Date().toISOString(),
    patientId,
    onError,
  } = {}) {
    const items = [];
    for (const record of this.ordered) {
      if (!this._isActive(record) || !record.spec) continue;
      for (const source of record.spec.agendaSources) {
        if (!this._sourceAvailable(record, source)) continue;
        try {
          const result = source.read(this.contextFor(record), {
            now,
            patientId,
          });
          if (Array.isArray(result))
            for (const item of result)
              if (item && typeof item === "object")
                items.push({
                  ...item,
                  kind: item.kind || source.kind,
                  pluginId: record.id,
                });
        } catch (error) {
          console.error(`插件 ${record.id} 待办来源失败:`, error);
          if (typeof onError === "function")
            try {
              onError({
                kind: source.kind,
                pluginId: record.id,
                message: errorMessage(error),
              });
            } catch {
              // A reporting callback must never break the remaining sources.
            }
        }
      }
    }
    return items;
  }

  _matchLegacyRoute(method, pathname) {
    for (const route of this.legacyRoutes) {
      if (route.method !== "*" && route.method !== method) continue;
      if (!route.record.available || !route.record.enabled) continue;
      if (!route.record.spec?.api) continue;
      const params = matchLegacyPath(route.path, pathname);
      if (params) return { route, params };
    }
    return null;
  }

  // Legacy API paths keep their historical URLs while their implementation
  // lives in a plugin. Returning false means "not handled" so the fixed shell
  // can continue with its own routes; a handler error becomes a normal 500.
  async handleLegacyApi(req, url, io) {
    if (!url.pathname.startsWith("/api/")) return false;
    const matched = this._matchLegacyRoute(req.method, url.pathname);
    if (!matched) return false;
    const { route, params } = matched;
    try {
      const handled = await route.record.spec.api(
        this.contextFor(route.record),
        req,
        url,
        { ...io, params: Object.freeze(params) },
      );
      return handled === true;
    } catch (error) {
      if (io.error) io.error(error);
      else
        io.send(Number.isInteger(error?.status) ? error.status : 500, {
          error: errorMessage(error),
          code: error?.code || "PLUGIN_API_ERROR",
        });
      return true;
    }
  }

  async handleApi(req, url, io) {
    if (!url.pathname.startsWith("/api/p/")) return false;
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    const record = id ? this.byId.get(id) : null;
    const prefix = id ? `/api/p/${id}/` : null;
    if (
      !record ||
      !record.available ||
      !record.enabled ||
      !record.spec?.api ||
      !url.pathname.startsWith(prefix)
    ) {
      io.send(404, {
        error: "插件不存在或未启用",
        code: "NOT_FOUND",
      });
      return true;
    }
    try {
      const handled = await record.spec.api(
        this.contextFor(record),
        req,
        url,
        io,
      );
      if (handled !== true)
        io.send(404, { error: "插件接口不存在", code: "NOT_FOUND" });
    } catch (error) {
      if (io.error) io.error(error);
      else
        io.send(Number.isInteger(error?.status) ? error.status : 500, {
          error: errorMessage(error),
          code: error?.code || "PLUGIN_API_ERROR",
        });
    }
    return true;
  }

  async startAll() {
    // Activation can depend on a status hook (for example a connected
    // messaging channel), so resolve it before deciding which loops to start.
    await this.listWithStatus();
    const results = [];
    for (const record of this.ordered) {
      if (!this._isActive(record) || !record.spec?.lifecycle)
        continue;
      const state = this.lifecycleStates.get(record.id);
      if (state === "started" || state === "starting") continue;
      this.lifecycleStates.set(record.id, "starting");
      this.startedPlugins.add(record.id);
      this.drainedPlugins.delete(record.id);
      try {
        if (record.spec.lifecycle.start)
          await record.spec.lifecycle.start(this.contextFor(record));
        this.lifecycleStates.set(record.id, "started");
        this.lifecycleErrors.delete(record.id);
        results.push({ id: record.id, ok: true });
      } catch (error) {
        this.lifecycleStates.set(record.id, "failed");
        this.lifecycleErrors.set(record.id, errorMessage(error));
        console.error(`插件 ${record.id} 启动失败:`, error);
        results.push({
          id: record.id,
          ok: false,
          error: errorMessage(error),
        });
      }
    }
    return results;
  }

  // Stopping walks the dependency order backwards. Each plugin is isolated:
  // one slow/failing stop never prevents the others from cleaning up.
  async stopAll() {
    const results = [];
    for (const record of [...this.ordered].reverse()) {
      if (
        !this.startedPlugins.has(record.id) ||
        !record.spec?.lifecycle ||
        this.lifecycleStates.get(record.id) === "stopped"
      )
        continue;
      try {
        if (record.spec.lifecycle.stop)
          await record.spec.lifecycle.stop(this.contextFor(record));
        this.lifecycleStates.set(record.id, "stopped");
        results.push({ id: record.id, ok: true });
      } catch (error) {
        this.lifecycleErrors.set(record.id, `停止失败：${errorMessage(error)}`);
        console.error(`插件 ${record.id} 停止失败:`, error);
        results.push({
          id: record.id,
          ok: false,
          error: errorMessage(error),
        });
      }
    }
    return results;
  }

  // Drain waits for in-flight work after stop; a plugin that never settles is
  // abandoned after the timeout so shutdown cannot hang forever.
  async drainAll({ timeoutMs = 5000, timeout } = {}) {
    const limit = Number.isFinite(timeout) ? timeout : timeoutMs;
    const results = [];
    for (const record of [...this.ordered].reverse()) {
      if (
        !this.startedPlugins.has(record.id) ||
        !record.spec?.lifecycle?.drain ||
        this.drainedPlugins.has(record.id)
      )
        continue;
      try {
        await withTimeout(
          record.spec.lifecycle.drain(this.contextFor(record)),
          limit,
          `插件 ${record.id} drain `,
        );
        this.drainedPlugins.add(record.id);
        results.push({ id: record.id, ok: true });
      } catch (error) {
        this.lifecycleErrors.set(record.id, `drain 失败：${errorMessage(error)}`);
        // A timed-out drain is abandoned, not retried during the same shutdown.
        this.drainedPlugins.add(record.id);
        console.error(`插件 ${record.id} drain 失败:`, error);
        results.push({
          id: record.id,
          ok: false,
          error: errorMessage(error),
        });
      }
    }
    return results;
  }

  async setEnabled(id, enabled) {
    check(typeof enabled === "boolean", "INVALID_INPUT", "enabled 必须是布尔值");
    const record = this.byId.get(id);
    check(record, "NOT_FOUND", "插件不存在", 404);
    const time = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO plugin_state(plugin_id,enabled,updated_at) VALUES (?,?,?)
         ON CONFLICT(plugin_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`,
      )
      .run(id, enabled ? 1 : 0, time);
    record.enabled = enabled;
    if (!enabled) this.statusCache.delete(id);
    // A runtime toggle must also start/stop background loops; routes alone are
    // not enough for plugins whose lifecycle owns timers or sockets.
    if (
      !enabled &&
      record.spec?.lifecycle &&
      this.startedPlugins.has(id) &&
      this.lifecycleStates.get(id) !== "stopped"
    ) {
      try {
        if (record.spec.lifecycle.stop)
          await record.spec.lifecycle.stop(this.contextFor(record));
        this.lifecycleStates.set(id, "stopped");
        this.lifecycleErrors.delete(id);
      } catch (error) {
        this.lifecycleErrors.set(id, `停止失败：${errorMessage(error)}`);
        console.error(`插件 ${id} 停止失败:`, error);
      }
    } else if (
      enabled &&
      record.available &&
      record.spec?.lifecycle &&
      ["stopped", "failed"].includes(this.lifecycleStates.get(id))
    ) {
      if (record.spec.activation?.requiresConnection)
        await this.listWithStatus();
      if (!this._isActive(record)) return this.list().find((item) => item.id === id);
      this.lifecycleStates.set(id, "starting");
      this.startedPlugins.add(id);
      this.drainedPlugins.delete(id);
      try {
        if (record.spec.lifecycle.start)
          await record.spec.lifecycle.start(this.contextFor(record));
        this.lifecycleStates.set(id, "started");
        this.lifecycleErrors.delete(id);
      } catch (error) {
        this.lifecycleStates.set(id, "failed");
        this.lifecycleErrors.set(id, errorMessage(error));
        console.error(`插件 ${id} 启动失败:`, error);
      }
    }
    this._buildLegacyRoutes();
    return this.list().find((item) => item.id === id);
  }

  // A plugin that declares activation.requiresConnection stays dormant until
  // its status hook reports a live connection. Status hooks are usually
  // async; the synchronous value is still honored so startup-time decisions
  // (tool registration, agenda sources) see a connected channel immediately.
  _connectedValue(value) {
    if (typeof value === "boolean") return value;
    if (value && typeof value === "object") {
      if (typeof value.connected === "boolean") return value.connected;
      if (typeof value.state === "string") return value.state === "ready";
    }
    return null;
  }

  _isActive(record) {
    if (!record.available || !record.enabled) return false;
    if (record.spec?.activation?.requiresConnection !== true) return true;
    const cached = this.statusCache.get(record.id);
    if (cached && typeof cached.connected === "boolean")
      return cached.connected === true;
    if (!record.spec.status) return false;
    try {
      const value = record.spec.status(this.contextFor(record));
      if (value && typeof value.then === "function") return false;
      return this._connectedValue(value) === true;
    } catch (error) {
      this.lifecycleErrors.set(
        record.id,
        `状态检查失败：${errorMessage(error)}`,
      );
      return false;
    }
  }

  isActive(id) {
    const record = this.byId.get(id);
    return record ? this._isActive(record) : false;
  }

  // Connection reported by an active plugin's status hook, read fresh when the
  // hook is synchronous. Used for features inside a plugin that need a live
  // channel while the rest of the plugin works without one.
  isConnected(id) {
    const record = this.byId.get(id);
    if (!record || !this._isActive(record) || !record.spec?.status) return false;
    try {
      const value = record.spec.status(this.contextFor(record));
      if (!value || typeof value.then !== "function")
        return this._connectedValue(value) === true;
    } catch {
      return false;
    }
    return this.statusCache.get(id)?.connected === true;
  }

  // Recompute activation after a connection change: start newly active
  // plugins and stop ones that went dormant. Order follows the dependency
  // graph so channel plugins are ready before followup starts.
  async syncActivation() {
    await this.listWithStatus();
    const results = [];
    for (const record of this.ordered) {
      if (!record.spec?.lifecycle) continue;
      const active = this._isActive(record);
      const state = this.lifecycleStates.get(record.id);
      const started = this.startedPlugins.has(record.id);
      if (active && (!started || state === "stopped" || state === "failed")) {
        this.lifecycleStates.set(record.id, "starting");
        this.startedPlugins.add(record.id);
        this.drainedPlugins.delete(record.id);
        try {
          if (record.spec.lifecycle.start)
            await record.spec.lifecycle.start(this.contextFor(record));
          this.lifecycleStates.set(record.id, "started");
          this.lifecycleErrors.delete(record.id);
          results.push({ id: record.id, ok: true, active: true });
        } catch (error) {
          this.lifecycleStates.set(record.id, "failed");
          this.lifecycleErrors.set(record.id, errorMessage(error));
          console.error(`插件 ${record.id} 启动失败:`, error);
          results.push({
            id: record.id,
            ok: false,
            active: true,
            error: errorMessage(error),
          });
        }
      } else if (!active && started && state !== "stopped") {
        try {
          if (record.spec.lifecycle.stop)
            await record.spec.lifecycle.stop(this.contextFor(record));
          this.lifecycleStates.set(record.id, "stopped");
          this.lifecycleErrors.delete(record.id);
          results.push({ id: record.id, ok: true, active: false });
        } catch (error) {
          this.lifecycleErrors.set(record.id, `停止失败：${errorMessage(error)}`);
          console.error(`插件 ${record.id} 停止失败:`, error);
          results.push({
            id: record.id,
            ok: false,
            active: false,
            error: errorMessage(error),
          });
        }
      }
    }
    return results;
  }

  _describe(record) {
    const spec = record.spec;
    const cached = this.statusCache.get(record.id);
    const staticCapabilities = spec?.capabilities ?? [];
    return {
      id: record.id,
      title: spec?.title || record.id,
      version: spec?.version || "0.0.0",
      enabled: record.enabled,
      available: record.available,
      active: this._isActive(record),
      connected: cached ? cached.connected : null,
      capabilities:
        cached && cached.capabilities !== undefined
          ? cached.capabilities
          : staticCapabilities,
      status: !record.available
        ? "unavailable"
        : record.enabled
          ? "ready"
          : "disabled",
      reason: record.reason,
    };
  }

  // Status hooks are optional and may be async. A hook error only affects the
  // reported connection state; it must never take down bootstrap or the host.
  async listWithStatus() {
    for (const record of this.ordered) {
      if (!record.spec) continue;
      let connected = null;
      let capabilities = record.spec.capabilities;
      if (record.available && record.enabled && record.spec.status) {
        try {
          const value = await withTimeout(
            record.spec.status(this.contextFor(record)),
            5000,
            `插件 ${record.id} status `,
          );
          if (typeof value === "boolean") connected = value;
          else if (value && typeof value === "object") {
            if (typeof value.connected === "boolean")
              connected = value.connected;
            else if (typeof value.state === "string")
              connected = value.state === "ready";
            if (value.capabilities !== undefined)
              capabilities =
                Array.isArray(capabilities) &&
                Array.isArray(value.capabilities)
                  ? [
                      ...new Set([
                        ...capabilities,
                        ...value.capabilities,
                      ]),
                    ]
                  : value.capabilities;
          }
        } catch (error) {
          this.lifecycleErrors.set(
            record.id,
            `状态检查失败：${errorMessage(error)}`,
          );
          console.error(`插件 ${record.id} 状态检查失败:`, error);
        }
      }
      this.statusCache.set(record.id, { connected, capabilities });
    }
    return this.list();
  }

  list() {
    return this.ordered
      .filter((record) => record.spec || record.reason)
      .map((record) => this._describe(record))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
