/** 一个提交工具，按筛选/制卡/复核阶段切换参数 schema。模型只提交数据，不执行副作用。 */

export const HARNESS_TOOL_NAME = 'submit_anki_harness_result';

type JsonSchema = Record<string, unknown>;

const string = { type: 'string' };
const boolean = { type: 'boolean' };

function itemSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
  };
}

const FILTER_ITEM = itemSchema({
  id: string,
  decision: { type: 'string', enum: ['keep', 'reject', 'review'] },
  reason: string,
});

const CARD_ITEM = itemSchema({
  id: string, meaning: string, sentenceTranslation: string, usage: string,
  nuance: string, needsReview: boolean, reviewReason: string,
});

const VERIFY_ITEM = itemSchema({ id: string, approved: boolean, reason: string });

export type HarnessToolStage = 'filter' | 'card' | 'verify';

export function harnessSubmissionTool(stage: HarnessToolStage): { name: string; description: string; parameters: JsonSchema } {
  const item = stage === 'filter' ? FILTER_ITEM : stage === 'card' ? CARD_ITEM : VERIFY_ITEM;
  const description = stage === 'filter'
    ? '提交每个候选词的保留、排除或待审判断。'
    : stage === 'card' ? '提交每张漫画学习卡的语境释义和句译草稿。'
      : '提交每张学习卡的复核结论。';
  return {
    name: HARNESS_TOOL_NAME, description,
    parameters: {
      type: 'object',
      properties: { items: { type: 'array', items: item } },
      required: ['items'],
      additionalProperties: false,
    },
  };
}
