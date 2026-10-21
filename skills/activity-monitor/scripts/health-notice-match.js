export const HEALTH_NOTICE_TEXT_MAX_BYTES = 16 * 1024;

const model = '(?:claude )?(?:fable|opus|sonnet|haiku)(?: [0-9]+(?:\\.[0-9]+)*)?';
const rule = (sourceId, kind, pattern) => ({ sourceId, kind, pattern });
// Ordered negatives precede quota refinements. These are source diagnostics,
// not permission to send a notice: the caller must apply the structured gate.
const RULES = [
  rule(25, 'temporary', /^(?:server is temporarily limiting requests\b|request rejected \(429\)|rate limit exceeded\b)/),
  rule(12, 'warning', /^(?:you've used \d+(?:\.\d+)?% of your\b|approaching (?:your )?(?:usage|session|weekly|opus|sonnet|fable|limit)\b|you're close to your usage(?: credit)? limit\b)/),
  rule(26, 'temporary', new RegExp(`^(?:${model} is experiencing high load\\b|repeated 529 overloaded errors\\b|overloaded\\b|the api is at capacity\\b|this is a server-side issue\\b)`)),
  rule(2, 'model_quota', /^fable limit reached · continuing on .{1,100} uses usage credits, and the prompt to confirm went unanswered\b/),
  rule(3, 'excluded', /^you've used your included fable usage for this week\b/),
  rule(5, 'credits_required', new RegExp(`^${model} now uses usage credits · the prompt to confirm went unanswered\\b`)),
  rule(5, 'excluded', new RegExp(`^${model} now uses usage credits(?:$|[ .·])`)),
  rule(1, 'model_quota', /^you've (?:reached your fable limit\.|hit your fable limit(?:$|[ .·]))/),
  rule(4, 'credits_required', new RegExp(`^${model} requires usage credits\\.`)),
  rule(4, 'quota', /^you've hit your (?:monthly spend limit|team's shared budget|channel's monthly spend limit)\. (?:\/model to switch models\.|run \/usage-credits\b|switch to another model to continue\.)/),
  rule(4, 'credits_exhausted', /^you're out of usage credits\. (?:\/model to switch models\.|run \/usage-credits\b|switch to another model to continue\.)/),
  rule(6, 'quota', /^you've hit your org's monthly (?:spend|usage) limit(?:$|[ ·])/),
  rule(7, 'quota', /^you've hit your (?:individual (?:spend|usage) limit(?:$|[ ·])|monthly spend limit · raise it\b)/),
  rule(8, 'quota', /^you've hit your channel's monthly (?:spend|usage) limit(?:$|[ ·])/),
  rule(9, 'quota', /^you've hit your team's shared budget(?:$|[ ·])/),
  rule(10, 'credits_exhausted', /^you're out of usage credits(?:$| ·)/),
  rule(10, 'excluded', /^your org is out of usage(?:$| ·)/),
  rule(11, 'model_quota', /^you've hit your (?:opus|sonnet) limit(?:$|[ .·])/),
  rule(11, 'quota', /^you've hit your (?:session|weekly) limit(?:$|[ .·])/),
  rule(13, 'allocation', /^(?:your seat type doesn't include usage(?: credits)?(?:$|[ .·])|your usage allocation has been disabled by your admin\b|your group's usage limit is set to \$0(?:$|[ .·]))/),
  rule(14, 'excluded', /^credit balance is too low(?:$|[ .·])/),
  rule(15, 'excluded', /^usage credits required for 1m context\b/),
  rule(16, 'excluded', /^(?:not logged in|authentication required)(?:$|[ .·])/),
  rule(17, 'excluded', /^(?:login expired|oauth token revoked|oauth token has expired|(?:failed to authenticate: )?oauth session expired)(?:$|[ .·])/),
  rule(18, 'excluded', /^could not refresh your login because another claude code process is refreshing\b/),
  rule(19, 'excluded', /^(?:invalid api key|invalid auth token|invalid anthropic_custom_headers|invalid request header)(?:$|[ .·])/),
  rule(20, 'excluded', /^(?:your organization has disabled (?:api key authentication|claude subscription access for claude code)|oauth authentication is currently not allowed for this organization)\b/),
  rule(21, 'excluded', /^could not load (?:aws|google cloud) credentials\b/),
  rule(22, 'excluded', /^(?:there's an issue with the selected model\b|the model .{1,100} is not available on your .{1,100} deployment\b)/),
  rule(23, 'excluded', /^(?:claude opus is not available with the claude pro plan\b|auto mode is unavailable for your plan\b|effort '[a-z]+' isn't available with thinking turned off on this model\b)/),
  rule(24, 'excluded', /^(?:claude_code_no_model_fallback is set: model substitution is disabled\b|your model policy only allows\b)/),
  rule(27, 'temporary', /^(?:connection to the api was lost\b|request timed out(?:$|[ .·])|no response from api\b|stream idle timeout\b)/),
  rule(28, 'excluded', /^(?:prompt is too long|context limit reached)(?:$|[ .·])/),
  rule(29, 'excluded', /^request too large(?:$|[ (])/),
  rule(30, 'excluded', /^(?:image was too large\b|an image in the conversation (?:could not be processed|exceeds the dimension limit)\b)/),
  rule(31, 'excluded', /^(?:pdf too large\b|pdf is password protected\b|the pdf file was not valid\b|a document in the conversation could not be processed\b|this model does not accept pdf documents\b)/),
  rule(32, 'excluded', /^(?:(?:400 )?due to tool use concurrency issues\b|tool use concurrency issues\b|orphaned tool_result\b|duplicate tool_use\b)/),
  rule(33, 'excluded', new RegExp(`^(?:output blocked by content filtering policy\\b|${model}'s safeguards flagged (?:this message|this session)\\b)`)),
  rule(0, 'quota', /^you've hit your (?:usage )?limit(?:$|[ .·])/),
];

export function matchHealthNoticeText(payload) {
  if (!payload || typeof payload !== 'object') return null;
  // Prefer the error field over assistant prose; an unknown error must not be
  // replaced by an unrelated example quoted in an otherwise successful reply.
  const text = typeof payload.error_details === 'string' && payload.error_details.trim()
    ? payload.error_details : payload.last_assistant_message;
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > HEALTH_NOTICE_TEXT_MAX_BYTES) return null;
  const normalized = text.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/^api error: (?:\d{3} )?/, '');
  for (const {sourceId, kind, pattern} of RULES) {
    if (pattern.test(normalized)) return {sourceId,kind};
  }
  return null;
}
