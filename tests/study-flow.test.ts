import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studyResumeStep } from '../src/core/study/flow';
import type { StudyList, StudyWorkflow, StudyTaskEntry } from '../src/shared/types';

const list = (flow: Partial<StudyWorkflow>): StudyList => ({
  bookId: 'test', generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates: [],
  workflow: { levels: [3], includeUnknown: false, ...flow },
});
const cardRun: NonNullable<StudyWorkflow['cardRun']> = {
  tier: 'A0', profileId: null, translationProfileId: '', completedAt: 1, sourceHash: 'old', drafts: [],
};
const filterRun: NonNullable<StudyWorkflow['filterRun']> = { tier: 'F1', profileId: 'test', completedAt: 1, decisions: {} };
const task = (kind: StudyTaskEntry['kind']): StudyTaskEntry => ({ id: 'task', bookId: 'test', title: 'test', kind,
  tier: kind === 'filter' ? 'F1' : 'A0', status: 'running', enqueuedAt: 1, done: 0, total: 1 });

test('study resumes the earliest unfinished operation before old published cards', () => {
  assert.equal(studyResumeStep(null), 'rules');
  assert.equal(studyResumeStep(list({ directAppliedAt: 0 })), 'rules');
  assert.equal(studyResumeStep(list({ directAppliedAt: 1 })), 'review');
  assert.equal(studyResumeStep(list({ filterRun })), 'review');
  assert.equal(studyResumeStep(list({ cardRun })), 'export');
  assert.equal(studyResumeStep(list({ cardRun, pendingFilterRun: { tier: 'F1', profileId: 'test', sourceHash: 'new', decisions: {} } })), 'ai');
  assert.equal(studyResumeStep(list({ cardRun, pendingCardRun: { ...cardRun, drafts: [] } })), 'meaning');
  assert.equal(studyResumeStep(list({ cardRun }), task('filter')), 'ai');
  assert.equal(studyResumeStep(list({ cardRun }), task('cards')), 'meaning');
});
