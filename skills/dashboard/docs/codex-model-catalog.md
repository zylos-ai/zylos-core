# Codex model identity and settings catalog

Dashboard uses the current rollout's latest `turn_context` for running model,
reasoning effort and service tier. Missing fields are unknown. A new, empty or
unavailable session clears prior runtime facts. Project configuration is exposed
separately as `configured_model` and `configured_effort`.

`src/lib/codex-models.js` maintains selectable models and their effort capabilities
independently of pricing and client discovery. Its initial entries match the
platform model catalog available during this change: GPT-6.1-Sol, GPT-6-Astra,
GPT-6-Sol and GPT-5.6-Sol expose low through ultra; GPT-6-Luna exposes low through
max. These are explicit platform options, not a claim about every Codex provider.
Update this catalog when verified provider capabilities change. Runtime display
keeps the reported name or raw ID, regardless of catalog membership.

The catalog also includes GPT-5.6-Terra and GPT-5.6-Luna with low through max,
and `gpt-5.6`, the official Sol alias, with Sol's existing Codex effort options.
These additions cover all GPT-6/GPT-5.6 entries in Dashboard's default pricing
catalog without deriving capabilities from prices. OpenAI model documentation
checked 2026-10-12 confirms the alias and Terra/Luna's max effort ceiling:
[Sol alias](https://developers.openai.com/api/docs/models/gpt-5.6),
[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).
API documentation also lists `none`; this catalog preserves Dashboard's existing
Codex reasoning controls, which start at low. Provider/account access remains
subject to the configured connection; listing a model does not grant access.

Configured and running IDs absent from the catalog remain visible in the settings
options with an empty effort list. A custom model can still be selected; changing
its effort is rejected until its capabilities are explicitly catalogued. Pricing
continues to use the independent pricing configuration, so catalog membership
does not establish a price and a price entry does not establish effort support.

Settings show the project configuration as the selected model/effort. Unset
configuration has an explicit placeholder, with no first-model or default-effort
fallback. Runtime evidence never silently becomes configuration.

No production path reads the Codex client's model-discovery file. Regression
tests include missing, corrupt and replaced discovery files, unknown IDs,
configuration/runtime disagreement, session switching and missing runtime fields,
as well as Claude and Fleet behavior.
