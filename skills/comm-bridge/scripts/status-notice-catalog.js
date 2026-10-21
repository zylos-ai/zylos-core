// Stable Core IDs. The source review's #1-33 are diagnostic rule IDs, not
// template IDs; historical Owner-specific K templates are intentionally absent.
export const NOTICE_TEMPLATES = Object.freeze({
  model_unavailable: Object.freeze({
    zh: '当前模型不可用，请检查模型配置或切换模型后重试。',
    en: 'The current model is unavailable. Please check the model configuration or switch models, then try again.',
  }),
  billing_error: Object.freeze({
    zh: '服务返回了计费错误，请联系该 Agent 的负责人检查账户计费状态后重试。',
    en: 'The service reported a billing error. Please contact the Agent owner to check the account billing status, then try again.',
  }),
  service_error: Object.freeze({
    zh: '服务返回了服务端错误或过载，请稍后重试。',
    en: 'The service reported a server error or overload. Please try again later.',
  }),
  quota_exhausted: Object.freeze({
    zh: '该 Agent 的使用额度已用完，请稍后重试；如需帮助，请联系该 Agent 的负责人。',
    en: 'This Agent has exhausted its usage quota. Please try again later, or contact the Agent owner for help.',
  }),
  quota_exhausted_reset: Object.freeze({
    zh: '该 Agent 的使用额度已用完，预计于 {resetAt} 重置。请在该时间之后重试。',
    en: 'This Agent has exhausted its usage quota. The quota is expected to reset at {resetAt}. Please try again after that time.',
  }),
  model_quota_exhausted: Object.freeze({
    zh: '当前模型的可用额度已用完，请联系该 Agent 的负责人切换模型后重试。',
    en: 'The current model has no available quota. Please contact the Agent owner to switch models, then try again.',
  }),
  usage_credits_required: Object.freeze({
    zh: '当前模型需要付费使用额度，请联系该 Agent 的负责人确认额度或切换模型后重试。',
    en: 'The current model requires paid usage credits. Please contact the Agent owner to check the available credits or switch models, then try again.',
  }),
  quota_allocation_unavailable: Object.freeze({
    zh: '该 Agent 当前没有可用的额度分配，请联系该 Agent 的负责人检查配置后重试。',
    en: 'This Agent currently has no available quota allocation. Please contact the Agent owner to check the configuration, then try again.',
  }),
  usage_credits_exhausted: Object.freeze({
    zh: '该 Agent 的付费使用额度已用完，请联系该 Agent 的负责人检查额度或切换模型后重试。',
    en: 'This Agent has exhausted its paid usage credits. Please contact the Agent owner to check the credits or switch models, then try again.',
  }),
});

const cases = [
  [1,'model_quota_exhausted','quota','model_limit'],
  [2,'model_quota_exhausted','conditional','unanswered_model_confirmation'],
  [3,null,'diagnostic','active_payment_dialog'],
  [4,null,'conditional','model_credits_or_spending_cap_variant'],
  [5,'usage_credits_required','conditional','unanswered_paid_confirmation'],
  [6,'quota_exhausted','quota','organization_cap'],
  [7,'quota_exhausted','quota','individual_cap'],
  [8,'quota_exhausted','quota','channel_cap'],
  [9,'quota_exhausted','quota','shared_budget'],
  [10,'usage_credits_exhausted','conditional','usage_credits_or_platform_billing'],
  [11,null,'conditional','session_weekly_or_model_limit'],
  [12,null,'diagnostic','approaching_quota_warning'],
  [13,'quota_allocation_unavailable','conditional','seat_allocation_or_zero_cap'],
  [14,null,'diagnostic','api_credit_balance'],
  [15,null,'diagnostic','context_purchase'],
  [16,null,'diagnostic','login_required'],
  [17,null,'diagnostic','login_expired'],
  [18,null,'diagnostic','login_refresh_race'],
  [19,null,'diagnostic','invalid_key_or_header'],
  [20,null,'diagnostic','authentication_policy'],
  [21,null,'diagnostic','cloud_credentials'],
  [22,null,'diagnostic','model_access'],
  [23,null,'diagnostic','plan_or_feature_access'],
  [24,null,'diagnostic','model_policy'],
  [25,null,'diagnostic','temporary_request_limit'],
  [26,null,'diagnostic','provider_capacity'],
  [27,null,'diagnostic','network_timeout'],
  [28,null,'diagnostic','context_limit'],
  [29,null,'diagnostic','request_size'],
  [30,null,'diagnostic','image_content'],
  [31,null,'diagnostic','pdf_content'],
  [32,null,'diagnostic','conversation_integrity'],
  [33,null,'diagnostic','content_filter_or_refusal'],
];

// This index is for coverage and diagnostics only. It cannot authorize a send.
// Quota/conditional rows still require the structured Hook and trusted-window
// policy; proven windows outrank text and #11 may instead identify model quota.
export const SOURCE_NOTICE_CASES = Object.freeze(cases.map(([id,noticeCode,eligibility,reason]) =>
  Object.freeze({ id,noticeCode,eligibility,reason })));
