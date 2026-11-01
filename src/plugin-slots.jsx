import {
  Component,
  Suspense,
  lazy,
  useSyncExternalStore,
} from "react";

// Fixed shell extension points. A plugin may only contribute to these names,
// which keeps the shell in control of placement and the plugin surface small.
export const SLOTS = [
  "patient.tabs",
  "patient.overviewCards",
  "patient.actions",
  "agenda.sources",
  "chat.resultCards",
  "proposal.renderers",
  "settings.panels",
  "tools.directory",
  "legacyViews",
];

const KEYED_SLOTS = new Set([
  "chat.resultCards",
  "proposal.renderers",
  "legacyViews",
]);
const ACTION_SLOT = "patient.actions";
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,39}$/;
const LEGACY_TAB = /^[a-z][a-z0-9-]*$/;
const PATIENT_AREAS = new Set(["record", "communication"]);
const COMPONENT_TYPES = new Set([
  Symbol.for("react.lazy"),
  Symbol.for("react.memo"),
  Symbol.for("react.forward_ref"),
]);

// React.lazy/memo/forwardRef are objects, not functions. Treat every valid
// React component type as renderable so the lazy wrapper is not mistaken for a
// missing contribution.
function isComponentType(value) {
  if (typeof value === "function") return true;
  if (!value || typeof value !== "object") return false;
  return COMPONENT_TYPES.has(value.$$typeof);
}

// React.lazy needs a module whose default export is a component. A loader that
// points at a named export makes React fail with an opaque error (#306), so
// check it here and name the plugin and slot instead.
function lazyComponent(loader, where) {
  return lazy(() =>
    Promise.resolve(loader()).then((module) => {
      if (!isComponentType(module?.default))
        throw new Error(
          `${where} 的加载函数没有返回默认导出的组件，请用 .then((m) => ({ default: m.组件名 })) 包装`,
        );
      return module;
    }),
  );
}

const registrations = new Map();
const listeners = new Set();
const EMPTY = Object.freeze([]);
let enabledIds = new Set();
let activeIds = new Set();
let connectedIds = new Set();
let slotsByName = new Map();
let activeSlotsByName = new Map();
let version = 0;

// 固定区自带的结果卡片（不属于任何插件，始终可用），如按条件找患者的名单。
let coreDefinition = null;
function coreUi() {
  coreDefinition ||= defineUiPlugin({
    id: "core",
    slots: {
      "chat.resultCards": {
        patient_cohort: {
          label: "查看患者名单",
          component: () => import("./cohort-card.jsx").then((module) => ({ default: module.CohortCard })),
        },
      },
    },
  });
  return coreDefinition;
}

function rebuild() {
  const next = new Map();
  for (const definition of [coreUi(), ...registrations.values()]) {
    if (definition.id !== "core" && !enabledIds.has(definition.id)) continue;
    for (const [name, contributions] of Object.entries(definition.slots)) {
      const list = next.get(name) || [];
      if (Array.isArray(contributions)) list.push(...contributions);
      else list.push(...Object.values(contributions));
      next.set(name, list);
    }
  }
  // A legacy tab can only be owned by one enabled plugin; keep the first by
  // plugin id and ignore later duplicates instead of rendering two buttons
  // with the same URL.
  const legacyOwners = new Map();
  for (const name of ["patient.tabs", "settings.panels"]) {
    const kept = [];
    for (const item of next.get(name) || []) {
      if (!item.legacyTab) {
        kept.push(item);
        continue;
      }
      const owner = legacyOwners.get(`${name}:${item.legacyTab}`);
      if (owner && owner !== item.pluginId) {
        console.error(
          `插件 ${item.pluginId} 的 ${name} legacyTab ${item.legacyTab} 与 ${owner} 冲突，已忽略`,
        );
        continue;
      }
      legacyOwners.set(`${name}:${item.legacyTab}`, item.pluginId);
      kept.push(item);
    }
    next.set(name, kept);
  }
  for (const [name, list] of next) {
    list.sort(
      (a, b) =>
        (a.order ?? 100) - (b.order ?? 100) ||
        a.pluginId.localeCompare(b.pluginId) ||
        String(a.id || a.type).localeCompare(String(b.id || b.type)),
    );
    next.set(name, Object.freeze(list));
  }
  slotsByName = next;
  const activeNext = new Map();
  for (const [name, list] of next)
    activeNext.set(
      name,
      Object.freeze(
        list.filter(
          (item) =>
            item.pluginId === "core" ||
            (activeIds.has(item.pluginId) &&
              (item.requiresConnection !== true ||
                connectedIds.has(item.pluginId))) ||
            item.availableWhenDormant === true,
        ),
      ),
    );
  activeSlotsByName = activeNext;
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => version;

export function isLegacyTab(value) {
  return typeof value === "string" && LEGACY_TAB.test(value);
}

// A plugin tab with legacyTab keeps its historical URL; otherwise it uses the
// namespaced p:<plugin>:<tab> form so two plugins can never collide.
export function patientTabKey(item) {
  if (!item) return "";
  return item.legacyTab || `p:${item.pluginId}:${item.id}`;
}

export function findPatientTab(contributions, tab) {
  return (contributions || []).find((item) => patientTabKey(item) === tab) || null;
}

// A patient-tab label may be a function because the historical "消息记录 · N
// 待整理" badge depends on the open patient. Other slots keep plain strings.
export function patientTabLabel(item, context) {
  return typeof item?.label === "function" ? item.label(context) : item?.label;
}

// Merge fixed patient tabs with plugin contributions for one area. A plugin
// legacyTab replaces the same fixed tab; other plugin tabs are appended and the
// whole list is sorted by the declared order (stable on plugin/id).
export function mergePatientTabs(
  contributions = [],
  { area = "record", builtin = [] } = {},
) {
  const merged = (builtin || []).map(([id, label, order], index) => ({
    id,
    key: id,
    label,
    order: Number.isFinite(order) ? order : (index + 1) * 10,
    builtin: true,
  }));
  for (const item of contributions || []) {
    if ((item.area || "record") !== area) continue;
    const entry = {
      id: item.id,
      key: patientTabKey(item),
      label: item.label,
      order: Number.isFinite(item.order) ? item.order : 100,
      pluginId: item.pluginId,
      area: item.area || "record",
      legacyTab: item.legacyTab,
      replacesBuiltin: Boolean(item.replacesBuiltin),
      contribution: item,
    };
    const replacement = item.legacyTab
      ? merged.findIndex((candidate) => candidate.id === item.legacyTab)
      : -1;
    if (replacement >= 0) merged[replacement] = entry;
    else merged.push(entry);
  }
  return merged.sort(
    (left, right) =>
      left.order - right.order ||
      String(left.pluginId || "").localeCompare(String(right.pluginId || "")) ||
      String(left.key).localeCompare(String(right.key)),
  );
}

export function findSettingsPanel(panels, section) {
  return (
    (panels || []).find((item) => item.legacyTab === section) || null
  );
}

// A UI plugin declaration is pure data: ids, labels, order and lazy component
// loaders. React.lazy is created once here so toggling a plugin cannot rebuild
// the component identity (and therefore cannot remount an open panel).
export function defineUiPlugin({ id, slots = {} } = {}) {
  if (typeof id !== "string" || !PLUGIN_ID.test(id))
    throw new Error("插件 UI 的 id 必须匹配 /^[a-z][a-z0-9-]{1,39}$/");
  if (!slots || typeof slots !== "object" || Array.isArray(slots))
    throw new Error(`插件 ${id} 的 slots 必须是对象`);
  const normalized = {};
  for (const [name, value] of Object.entries(slots)) {
    if (!SLOTS.includes(name))
      throw new Error(`插件 ${id} 使用了未知插槽 ${name}`);
    if (KEYED_SLOTS.has(name)) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`插件 ${id} 的插槽 ${name} 必须是 { 类型: 加载函数 }`);
      const keyed = {};
      for (const [type, contribution] of Object.entries(value)) {
        if (typeof type !== "string" || !type.trim())
          throw new Error(`插件 ${id} 的插槽 ${name} 缺少类型`);
        const loader =
          typeof contribution === "function"
            ? contribution
            : contribution?.component;
        if (typeof loader !== "function")
          throw new Error(`插件 ${id} 的插槽 ${name}.${type} 必须是加载函数`);
        if (
          typeof contribution !== "function" &&
          contribution.label !== undefined &&
          typeof contribution.label !== "string"
        )
          throw new Error(`插件 ${id} 的插槽 ${name}.${type} 的 label 必须是字符串`);
        keyed[type] = Object.freeze({
          pluginId: id,
          type,
          order: Number.isFinite(contribution?.order)
            ? contribution.order
            : 100,
          label:
            typeof contribution === "function" ? undefined : contribution.label,
          component: lazyComponent(loader, `插件 ${id} 的插槽 ${name}.${type}`),
        });
      }
      normalized[name] = Object.freeze(keyed);
      continue;
    }
    if (!Array.isArray(value))
      throw new Error(`插件 ${id} 的插槽 ${name} 必须是贡献数组`);
    if (name === ACTION_SLOT) {
      normalized[name] = Object.freeze(
        value.map((item, index) => {
          if (!item || typeof item !== "object")
            throw new Error(`插件 ${id} 的插槽 ${name}[${index}] 无效`);
          if (typeof item.id !== "string" || !item.id.trim())
            throw new Error(`插件 ${id} 的插槽 ${name}[${index}] 缺少 id`);
          if (typeof item.run !== "function")
            throw new Error(
              `插件 ${id} 的插槽 ${name}.${item.id} 缺少 run 函数`,
            );
          return Object.freeze({
            pluginId: id,
            id: item.id,
            label: item.label || item.id,
            order: Number.isFinite(item.order) ? item.order : 100,
            run: item.run,
          });
        }),
      );
      continue;
    }
    const legacyTabs = new Set();
    normalized[name] = Object.freeze(
      value.map((item, index) => {
        if (!item || typeof item !== "object")
          throw new Error(`插件 ${id} 的插槽 ${name}[${index}] 无效`);
        if (typeof item.id !== "string" || !item.id.trim())
          throw new Error(`插件 ${id} 的插槽 ${name}[${index}] 缺少 id`);
        if (typeof item.component !== "function")
          throw new Error(
            `插件 ${id} 的插槽 ${name}.${item.id} 缺少 component 加载函数`,
          );
        if (
          item.label !== undefined &&
          typeof item.label !== "string" &&
          !(name === "patient.tabs" && typeof item.label === "function")
        )
          throw new Error(
            `插件 ${id} 的插槽 ${name}.${item.id} 的 label 必须是字符串`,
          );
        if (
          item.meta !== undefined &&
          (!item.meta || typeof item.meta !== "object" || Array.isArray(item.meta))
        )
          throw new Error(
            `插件 ${id} 的插槽 ${name}.${item.id} 的 meta 必须是对象`,
          );
        const legacyTab = item.legacyTab;
        if (legacyTab !== undefined && !isLegacyTab(legacyTab))
          throw new Error(
            `插件 ${id} 的插槽 ${name}.${item.id} 的 legacyTab 必须匹配 /^[a-z][a-z0-9-]*$/`,
          );
        if (legacyTab !== undefined) {
          if (legacyTabs.has(legacyTab))
            throw new Error(
              `插件 ${id} 的插槽 ${name} 重复声明 legacyTab ${legacyTab}`,
            );
          legacyTabs.add(legacyTab);
        }
        const area = item.area ?? "record";
        if (name === "patient.tabs" && !PATIENT_AREAS.has(area))
          throw new Error(
            `插件 ${id} 的插槽 patient.tabs.${item.id} 的 area 必须是 record 或 communication`,
          );
        if (item.requiresConnection !== undefined && typeof item.requiresConnection !== "boolean")
          throw new Error(
            `插件 ${id} 的插槽 ${name}.${item.id} 的 requiresConnection 必须是布尔值`,
          );
        if (item.replacesBuiltin !== undefined && typeof item.replacesBuiltin !== "boolean")
          throw new Error(
            `插件 ${id} 的插槽 ${name}.${item.id} 的 replacesBuiltin 必须是布尔值`,
          );
        return Object.freeze({
          pluginId: id,
          id: item.id,
          label: item.label || item.id,
          order: Number.isFinite(item.order) ? item.order : 100,
          ...(item.meta ? { meta: Object.freeze({ ...item.meta }) } : {}),
          // A contribution inside an active plugin that only makes sense
          // while the plugin reports a live connection (e.g. patient messages).
          ...(item.requiresConnection === true ? { requiresConnection: true } : {}),
          ...(name === "patient.tabs"
            ? {
                area,
                legacyTab,
                replacesBuiltin: item.replacesBuiltin === true || Boolean(legacyTab),
              }
            : name === "settings.panels"
              ? {
                  legacyTab,
                  // Connection panels must stay reachable while the business
                  // plugin is dormant; otherwise the doctor cannot reconnect.
                  availableWhenDormant: item.availableWhenDormant === true,
                }
              : {}),
          component: lazyComponent(item.component, `插件 ${id} 的插槽 ${name}.${item.id}`),
        });
      }),
    );
  }
  return Object.freeze({ id, slots: Object.freeze(normalized) });
}

// `modules` is the module map produced by plugin-registry.js (production
// entries are eager, E2E fixture entries are materialized before this call).
// Only plugins whose server status is "ready" are registered, so a disabled or
// unavailable plugin never contributes DOM.
export function registerUiPlugins(modules = {}, enabled = [], active = enabled, connected = undefined) {
  enabledIds = new Set(
    Array.isArray(enabled) ? enabled : enabled instanceof Set ? enabled : [],
  );
  // `active` is the host's activation verdict (enabled && available &&
  // connected when the plugin requires a channel). Older callers that only
  // pass `enabled` keep the previous behavior.
  activeIds = new Set(
    Array.isArray(active) ? active : active instanceof Set ? active : activeIds,
  );
  // `connected` is each plugin's status().connected. Plugins that do not
  // report a connection simply never satisfy requiresConnection.
  connectedIds = new Set(
    Array.isArray(connected) ? connected : connected instanceof Set ? connected : connectedIds,
  );
  registrations.clear();
  for (const key of Object.keys(modules).sort()) {
    try {
      const definition = modules[key]?.default ?? modules[key];
      if (!definition?.id) continue;
      // The module factory is evaluated eagerly by import.meta.glob, so an
      // invalid declaration is caught here instead of taking down the shell.
      if (typeof definition.id !== "string") continue;
      registrations.set(definition.id, definition);
    } catch (error) {
      console.error("插件 UI 注册失败:", key, error);
    }
  }
  rebuild();
}

export function useSlot(name) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return slotsByName.get(name) || EMPTY;
}

// Contributions from dormant plugins stay registered (their settings/empty
// state may still be needed) but business-facing slots can opt out.
export function useActiveSlot(name) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return activeSlotsByName.get(name) || EMPTY;
}

// Fixed-shell entry points use this to show or hide affordances that start a
// plugin workflow. Disabled plugins are absent from enabledIds immediately
// after registration, without a page reload.
export function usePluginEnabled(id) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return enabledIds.has(id);
}

// Same store, but reflects "enabled and activated". A plugin that requires a
// connected channel is dormant until the host reports activation, without
// disappearing from settings (connection panels stay renderable).
export function usePluginActive(id) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return activeIds.has(id);
}

// "Active and reporting a live connection". The followup plugin is always
// active (doctor reminders), but patient messaging needs a WeChat/WeCom
// channel; UI that reaches patients checks this instead of usePluginActive.
export function usePluginConnected(id) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return activeIds.has(id) && connectedIds.has(id);
}

// Exported so the server-render regression test can exercise the fallback
// directly: React's streaming SSR intentionally defers component errors inside
// a Suspense boundary to client rendering, so it cannot observe this fallback.
export class PluginErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("插件组件渲染失败:", error, info);
  }

  render() {
    if (this.state.error)
      return (
        <p className="plugin-slot-error" role="alert">
          插件组件出错：{this.state.error?.message || "未知错误"}
        </p>
      );
    return this.props.children;
  }
}

// Renders one contribution with its own lazy boundary. It intentionally adds
// no wrapper element: an empty slot produces no DOM at all.
export function SlotItem({ contribution, ...props }) {
  if (!isComponentType(contribution?.component)) return null;
  const Content = contribution.component;
  return (
    <Suspense fallback={null}>
      <PluginErrorBoundary
        key={`${contribution.pluginId}:${contribution.id || contribution.type}`}
      >
        <Content {...props} />
      </PluginErrorBoundary>
    </Suspense>
  );
}

export function Slot({ name, ...props }) {
  const contributions = useSlot(name);
  if (!contributions.length) return null;
  return (
    <>
      {contributions.map((contribution) => (
        <SlotItem
          key={`${contribution.pluginId}:${contribution.id || contribution.type}`}
          contribution={contribution}
          {...props}
        />
      ))}
    </>
  );
}

export function useLegacyView(view) {
  const views = useSlot("legacyViews");
  return views.find((item) => item.type === view) || null;
}

// legacyViews keeps the historical ?view= URL while rendering a plugin
// component. Missing contributions return the fixed shell's own renderer.
export function LegacyView({ view, fallback = null, ...props }) {
  const contribution = useLegacyView(view);
  if (!contribution)
    return typeof fallback === "function" ? fallback() : fallback;
  return (
    <SlotItem
      contribution={contribution}
      view={view}
      {...props}
    />
  );
}

// chat.resultCards is keyed by artifact type. A missing contribution falls back
// to the fixed shell's original rendering; no wrapper or placeholder is added.
export function ResultCard({ artifact, fallback = null, ...props }) {
  const cards = useSlot("chat.resultCards");
  const contribution = artifact?.type
    ? cards.find((item) => item.type === artifact.type)
    : null;
  if (!contribution)
    return typeof fallback === "function" ? fallback() : fallback;
  return <SlotItem contribution={contribution} artifact={artifact} {...props} />;
}
