// Debug-only, isolated book/library; no real provider or account is contacted.
window.__araleStudySmoke = async ({check,until,evidence,id}) => {
  const api=window.arale;
  evidence.studyBookTitle=(await api.library.open(id)).book.title;
  const list=await api.study.generate(id);
  check('study Worker generates JLPT candidates with packaged Zipf data',list.candidates.length>0 && !!list.wordfreqSource && list.candidates.some(c=>typeof c.zipf==='number'));
  evidence.studyGenerated=structuredClone(list);
  const ids=list.candidates.map(c=>c.id);
  const chosen=list.candidates.find(c=>c.expression==='猫') ?? list.candidates.find(c=>c.reading && c.meaning);
  check('study finds a dictionary-backed candidate',!!chosen);
  await api.study.patchMany(id,ids,{selected:false});
  await api.study.patch(id,chosen.id,{selected:true});
  const fields=['reading','meaning','sentence','sentenceTranslation','lemma'];
  const run=async (tier,extra={})=>{
    const task=await api.study.runCards(id,{tier,profileId:'local',translationProfileId:'libretranslate',fields,concurrency:3,...extra});
    await until(async()=> (await api.study.taskQueue()).recent.some(t=>t.id===task.id),tier+' study task');
    const done=(await api.study.taskQueue()).recent.find(t=>t.id===task.id);
    check(tier+' study queue completes',done.status==='completed');
    return await api.study.read(id);
  };
  const local=await run('A0',{fields:['reading','meaning','sentence','lemma']});
  check('A0 produces dictionary card without external calls',local.workflow.cardRun.stats.llmCalls===0 && local.workflow.cardRun.stats.translationCalls===0 && !local.workflow.cardRun.drafts[0].needsReview);
  const basic=await run('A1');
  check('A1 uses native translation and retains all five fields',basic.workflow.cardRun.stats.llmCalls===0 && basic.workflow.cardRun.drafts[0].fields.length===5 && !!basic.workflow.cardRun.drafts[0].sentenceTranslation);
  const fill=await run('A2');
  check('A2 skips LLM for existing dictionary meaning',fill.workflow.cardRun.stats.llmCalls===0);
  await run('A3');
  const full=await run('A4');
  evidence.studyFull=structuredClone(full);
  check('A4 invokes shared harness through native model HTTP',full.workflow.cardRun.stats.llmCalls>0 && full.workflow.cardRun.drafts[0].meaning==='测试语境词义' && !full.workflow.cardRun.drafts[0].needsReview);
  const profiles=(await api.llm.settings()).profiles;
  await api.llm.update({profiles:profiles.map(p=>({...p,model:'study-truncate'}))});
  const recovered=await run('A4');
  check('native harness recovers closed card from length-truncated tool output and charges usage',recovered.workflow.cardRun.stats.llmCalls===1 && recovered.workflow.cardRun.pipeline.budgetUsed===30 && !recovered.workflow.cardRun.drafts[0].needsReview);
  await api.llm.update({profiles:profiles.map(p=>({...p,model:'test'}))});
  const text=await api.study.export(id);
  check('study TSV writes native selected-file grant',text.count===1 && text.path.endsWith('.tsv'));
  evidence.studyText=text;
  evidence.studyPackages=[];
  for(const mode of ['none','crop','page']){
    await api.study.setImageMode(id,mode);
    const exported=await api.study.exportPackage(id);
    check('native Anki SQLite/APKG export with '+mode+' image',exported.count===1 && exported.path.endsWith('.apkg'));
    evidence.studyPackages.push({...exported,mode});
  }
  check('successful native APKG persists exportedAt',(await api.study.read(id)).candidates.find(c=>c.id===chosen.id).exportedAt>0);
  await api.study.clearCardProgress(id);
  const manual=await api.study.exportManualAi(id,{kind:'cards',tasksPerFile:1,fields});
  const session=manual.workflow.manualAi.cards, task=session.tasks[0];
  check('manual AI automatically exports MD to the application temp directory',session.batches.length===1 && /[\\/]temp[\\/]manual-ai[\\/]/.test(session.directory));
  evidence.studyManualDirectory=session.directory;
  await api.study.revealManualAi(id,'cards');
  check('native manual AI folder action succeeds for canonical Windows path',true);
  const reply={sessionId:session.id,batchId:session.batches[0].id,items:[{id:chosen.id,reading:task.candidate.reading,meaning:'手动词义',sentenceTranslation:'手动句译',usage:'',nuance:'',evidenceIds:task.evidence.map(e=>e.id),issues:[]}]};
  check('manual AI rejects foreign IDs without changing progress',await api.study.importManualAi(id,'cards',JSON.stringify({...reply,items:[{...reply.items[0],id:'foreign'}]})).then(()=>false,async()=>!(await api.study.read(id)).workflow.manualAi.cards.batches[0].completed));
  const restored=await api.study.importManualAi(id,'cards',JSON.stringify(reply));
  check('manual AI imports validated result without paid calls',restored.workflow.cardRun.profileId==='external-ai' && restored.workflow.cardRun.stats.llmCalls===0 && restored.workflow.cardRun.drafts[0].meaning==='手动词义');
  await api.study.clearManualAi(id,'cards');
  // F1/F2/F3 operate on the rule-filtered selection, independent of card selection.
  for(const tier of ['F1','F2','F3']){
    await api.study.directFilter(id,[1,2,3,4,5],true);
    const task=await api.study.runFilter(id,{tier,profileId:'local',concurrency:3});
    await until(async()=>(await api.study.taskQueue()).recent.some(t=>t.id===task.id),tier+' filter');
    const done=(await api.study.taskQueue()).recent.find(t=>t.id===task.id);
    check(tier+' filtering follows shared harness',done.status==='completed');
  }
  await api.study.patchMany(id,ids,{selected:false});
  await api.study.patch(id,chosen.id,{selected:true});
  // Budget exhaustion remains a checkpoint/deferred result, not an automatic paid retry.
  const budget=await run('A4',{tokenBudget:1000});
  check('native study preserves budget-deferred card without LLM',budget.workflow.cardRun.stats.llmCalls===0 && budget.workflow.cardRun.drafts[0].status==='deferred');
  await api.study.clearCardProgress(id);
  evidence.studyId=id;
  evidence.studyChosenId=chosen.id;
};
