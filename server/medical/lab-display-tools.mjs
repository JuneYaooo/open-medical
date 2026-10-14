import { check } from '../errors.mjs';

const definition = (name, description, properties, required) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
} });
const keys = { type: 'array', items: { type: 'string' }, maxItems: 1000 };
export function labDisplayTools(getPatients) {
  const target = (args, context = {}) => {
    check(!context.patientId || context.patientId === args.patientId, 'INVALID_INPUT', '只能调整当前患者的检验展示');
    return getPatients();
  };
  return [
    {
      definition: definition('patient_lab_display_get', '读取患者检验页面的展示偏好及全部指标（key 精确区分项目和单位）。调整排序、对比、折叠或隐藏前先读取；这是页面偏好，不是病历编辑。', { patientId: { type: 'string' } }, ['patientId']),
      execute: (args, context) => target(args, context).labDisplay(args.patientId),
    },
    {
      definition: definition('patient_lab_display_update', '按用户明确要求保存当前患者检验页面的展示习惯，重开页面仍生效。先 get 再用返回的 key 和 revision 更新。order 是优先顺序；compare 是参与日期对照的指标（空数组不显示对照）；collapsed 收起图表但保留摘要；hidden 移至隐藏区。各数组替换该字段，未传字段保留原值，必须保留用户没有要求改变的偏好。reset=true 恢复默认全部展示。只调整展示，不修改检验数据、监测或风险提醒。', {
        patientId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 },
        order: keys, compare: keys, collapsed: keys, hidden: keys, reset: { type: 'boolean' },
      }, ['patientId', 'expectedRevision']),
      execute: ({ patientId, ...input }, context) => target({ patientId }, context).updateLabDisplay(patientId, input),
    },
  ];
}
