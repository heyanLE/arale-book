import type { StudyList, StudyTaskEntry } from '../../shared/types';

export type StudyStep = 'rules' | 'ai' | 'review' | 'meaning' | 'export';

/** Resume unfinished work before showing an older published result. */
export function studyResumeStep(list: StudyList | null, task?: StudyTaskEntry | null): StudyStep {
  if (task) return task.kind === 'filter' ? 'ai' : 'meaning';
  const flow = list?.workflow;
  if (!flow) return 'rules';
  if (flow.pendingFilterRun || (flow.manualAi?.filter && !flow.manualAi.filter.completedAt)) return 'ai';
  if (flow.pendingCardRun || (flow.manualAi?.cards && !flow.manualAi.cards.completedAt)) return 'meaning';
  if (flow.cardRun) return 'export';
  if (flow.filterRun || flow.directAppliedAt) return 'review';
  return 'rules';
}
