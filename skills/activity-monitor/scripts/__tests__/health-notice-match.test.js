import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchHealthNoticeText, HEALTH_NOTICE_TEXT_MAX_BYTES} from '../health-notice-match.js';
import {classifyHealthNotice} from '../health-notice-classification.js';

const examples = [
  [1,'model_quota',"You've reached your Fable limit. /model to switch models."],
  [2,'model_quota','Fable limit reached · continuing on Opus uses usage credits, and the prompt to confirm went unanswered — nothing was sent'],
  [3,'excluded',"You've used your included Fable usage for this week. Continuing on Opus uses usage credits"],
  [4,'credits_required','Fable 5 requires usage credits. /model to switch models.'],
  [5,'credits_required','Opus now uses usage credits · the prompt to confirm went unanswered — nothing was sent'],
  [6,'quota',"You've hit your org's monthly spend limit · ask your admin for a higher limit"],
  [7,'quota',"You've hit your individual usage limit · resets tomorrow"],
  [8,'quota',"You've hit your channel's monthly spend limit · ask your admin"],
  [9,'quota',"You've hit your team's shared budget · ask your admin"],
  [10,'credits_exhausted',"You're out of usage credits · resets 3pm"],
  [11,'quota',"You've hit your session limit · resets 3pm"],
  [12,'warning',"You've used 90% of your session limit · resets 3pm"],
  [13,'allocation',"Your group's usage limit is set to $0"],
  [14,'excluded','Credit balance is too low'],
  [15,'excluded','API Error: Usage credits required for 1M context · run /usage-credits'],
  [16,'excluded','Not logged in · Please run /login'],
  [17,'excluded','OAuth token revoked · Please run /login'],
  [18,'excluded','Could not refresh your login because another Claude Code process is refreshing it'],
  [19,'excluded','Invalid API key · Fix external API key'],
  [20,'excluded','Your organization has disabled Claude subscription access for Claude Code'],
  [21,'excluded','API Error: Could not load AWS credentials · refresh credentials'],
  [22,'excluded',"There's an issue with the selected model (Opus). It may not exist"],
  [23,'excluded','Claude Opus is not available with the Claude Pro plan.'],
  [24,'excluded','CLAUDE_CODE_NO_MODEL_FALLBACK is set: model substitution is disabled'],
  [25,'temporary','API Error: Server is temporarily limiting requests (not your usage limit)'],
  [26,'temporary','API Error: Repeated 529 Overloaded errors. The API is at capacity'],
  [27,'temporary','API Error: Connection to the API was lost (ECONNRESET).'],
  [28,'excluded','Prompt is too long'],
  [29,'excluded','Request too large (max 32MB).'],
  [30,'excluded','Image was too large. Double press esc'],
  [31,'excluded','PDF is password protected.'],
  [32,'excluded','API Error: 400 due to tool use concurrency issues. Run /rewind'],
  [33,'excluded','API Error: Output blocked by content filtering policy'],
];
for (const [sourceId,kind,text] of examples) {
  test(`source #${sourceId}: sanitized ${kind} diagnostic`,()=>{
    assert.deepEqual(matchHealthNoticeText({error_details:text}),{sourceId,kind});
    assert.equal(matchHealthNoticeText({last_assistant_message:`The customer pasted this example: ${text}`}),null);
    assert.equal(matchHealthNoticeText({last_assistant_message:`\"${text}\"`}),null);
  });
}
test('normalizes case, curly apostrophes and whitespace without erasing punctuation',()=>{
  assert.deepEqual(matchHealthNoticeText({last_assistant_message:'  YOU’VE\n hit your\tFable limit · resets 3pm '}),{sourceId:1,kind:'model_quota'});
  assert.equal(matchHealthNoticeText({error_details:"You've reached your Fable limit"}),null);
});
test('error_details has priority and cannot fall back to unrelated assistant quota prose',()=>{
  assert.equal(matchHealthNoticeText({error_details:'Unknown error',last_assistant_message:examples[0][2]}),null);
  assert.deepEqual(matchHealthNoticeText({error_details:' ',last_assistant_message:examples[0][2]}),{sourceId:1,kind:'model_quota'});
});
test('oversized text fails neutral rather than matching a truncated prefix',()=>{
  assert.equal(matchHealthNoticeText({error_details:examples[0][2]+'x'.repeat(HEALTH_NOTICE_TEXT_MAX_BYTES)}),null);
  assert.equal(matchHealthNoticeText({error_details:'中'.repeat(6000),last_assistant_message:examples[0][2]}),null);
});
test('negative diagnostics cannot refine into quota even when quota text follows',()=>{
  for (const id of [12,25,26]) {
    const [sourceId,kind,text]=examples.find(row=>row[0]===id);
    assert.deepEqual(matchHealthNoticeText({error_details:`${text}. You've hit your weekly limit`}),{sourceId,kind});
  }
});
test('active dialogs and broad non-diagnostic fragments do not authorize quota notices',()=>{
  assert.deepEqual(matchHealthNoticeText({error_details:'Opus now uses usage credits'}),{sourceId:5,kind:'excluded'});
  for (const text of ['Switch to another model to continue','Could not load my file','This service is disabled for your org','Fable limit reached · continuing on Opus uses usage credits','You have not hit your weekly limit']) assert.equal(matchHealthNoticeText({error_details:text}),null);
});
test('specific quota variants retain distinct source and kind',()=>{
  for (const [text,sourceId,kind] of [
    ["You've hit your Opus limit · resets 3pm",11,'model_quota'],
    ["You're out of usage credits. Switch to another model to continue.",4,'credits_exhausted'],
    ["You've hit your monthly spend limit. /model to switch models.",4,'quota'],
    ["You've hit your team's shared budget. /model to switch models.",4,'quota'],
    ["You've hit your usage limit · resets 3pm",0,'quota'],
    ['Your org is out of usage · add funds to continue',10,'excluded'],
  ]) assert.deepEqual(matchHealthNoticeText({error_details:text}),{sourceId,kind});
});

test('paid requirement and budget diagnostics never claim exhausted model quota',()=>{
  for (const [text,code] of [
    ['Opus now uses usage credits · the prompt to confirm went unanswered — nothing was sent','usage_credits_required'],
    ["You've hit your team's shared budget. /model to switch models.",'quota_exhausted'],
    ["You've hit your monthly spend limit. /model to switch models.",'quota_exhausted'],
  ]) {
    const notice_match=matchHealthNoticeText({error_details:text});
    const notice=classifyHealthNotice({error:'billing_error',notice_match,received_at:1000},1000);
    assert.equal(notice.eligible,true);assert.equal(notice.noticeCode,code);
    assert.equal(notice.resetAt,null);
  }
});
