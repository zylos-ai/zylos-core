/*
Protocol constraints adapted from zz-howard/chatweave @ 03e69a4435ce2f4913ed28884509f3db64d6ebcf,
schemas/v0.1/content-block.schema.json and action.schema.json.

MIT License

Copyright (c) 2026 Howard Zhou

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// The fixed v1 definitions live here; generated delivery data is embedded in the schema module.
export const CATALOG_SOURCE = { coreCommit: '977958c913d19be5ebe80fa03a5133f61b4acbb9',
  chatweaveCommit: '03e69a4435ce2f4913ed28884509f3db64d6ebcf' };

const BLOCK_SCHEMA = {"type":"object","required":["id","type","schemaVersion"],"additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/blockId"},"type":{"enum":["markdown","time_series","breakdown","category_series","choice","confirmation","form_intent"]},"schemaVersion":{"const":1},"data":{"type":"object"},"fallbackText":{"type":"string","maxLength":2000},"metadata":{"$ref":"#/$defs/blockMetadata"},"status":{"type":"string","enum":["complete","pending","error"]},"reason":{"type":"string","maxLength":500}},"allOf":[{"if":{"properties":{"type":{"not":{"const":"markdown"}}}},"then":{"required":["fallbackText"]}},{"if":{"properties":{"type":{"const":"markdown"}}},"then":{"properties":{"data":{"$ref":"#/$defs/markdownData"}}}},{"if":{"properties":{"type":{"const":"time_series"}}},"then":{"properties":{"data":{"$ref":"#/$defs/timeSeriesData"}}}},{"if":{"properties":{"type":{"const":"breakdown"}}},"then":{"properties":{"data":{"$ref":"#/$defs/breakdownData"}}}},{"if":{"properties":{"type":{"const":"category_series"}}},"then":{"properties":{"data":{"$ref":"#/$defs/categorySeriesData"}}}},{"if":{"properties":{"type":{"const":"choice"}}},"then":{"properties":{"data":{"$ref":"#/$defs/choiceData"}}}},{"if":{"properties":{"type":{"const":"confirmation"}}},"then":{"properties":{"data":{"$ref":"#/$defs/confirmationData"}}}},{"if":{"properties":{"type":{"const":"form_intent"}}},"then":{"properties":{"data":{"$ref":"#/$defs/formIntentData"}}}},{"if":{"properties":{"status":{"enum":["pending","error"]}},"required":["status"]},"then":{"required":["fallbackText"]},"else":{"required":["data"]}},{"if":{"properties":{"status":{"const":"error"}},"required":["status"]},"else":{"not":{"required":["reason"]}}},{"if":{"properties":{"metadata":{"properties":{"provenance":{"const":"adapter"}},"required":["provenance"]}},"required":["metadata"]},"then":{"properties":{"type":{"const":"markdown"}}}}],"$defs":{"blockId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"key":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"label":{"type":"string","minLength":1,"maxLength":120},"shortLabel":{"type":"string","minLength":1,"maxLength":24},"text":{"type":"string","maxLength":2000},"unit":{"type":"string","minLength":1,"maxLength":32},"scalar":{"type":["number","string","boolean","null"],"maxLength":500},"temporal":{"type":"string","anyOf":[{"format":"date"},{"format":"date-time"}]},"assessment":{"type":"object","required":["status"],"additionalProperties":false,"properties":{"status":{"type":"string","enum":["positive","negative","warning","critical","neutral","info"]},"label":{"$ref":"#/$defs/label"},"detail":{"$ref":"#/$defs/text"}}},"valueFormat":{"type":"object","additionalProperties":false,"properties":{"style":{"type":"string","enum":["decimal","integer","percent","currency","duration"]},"currency":{"type":"string","pattern":"^[A-Z]{3}$"},"minorUnits":{"type":"boolean"},"maximumFractionDigits":{"type":"integer","minimum":0,"maximum":6}}},"blockMetadata":{"type":"object","additionalProperties":false,"properties":{"provenance":{"type":"string","enum":["model","tool","host","adapter"]},"asOf":{"type":"string","format":"date-time"},"citations":{"type":"array","maxItems":10,"items":{"type":"object","required":["label"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"url":{"type":"string","format":"uri","maxLength":2000},"ref":{"type":"string","maxLength":128}}}},"host":{"type":"object","maxProperties":16}}},"blockState":{"type":"object","required":["status"],"additionalProperties":false,"properties":{"status":{"type":"string","enum":["open","resolved","expired","cancelled","superseded"]},"selected":{"type":"array","maxItems":10,"items":{"$ref":"action.schema.json#/$defs/optionId"},"minItems":1,"uniqueItems":true},"freeText":{"type":"string","maxLength":500,"minLength":1},"outcome":{"type":"string","enum":["confirm","cancel"]},"values":{"type":"object","maxProperties":12},"resolvedBy":{"type":"string","minLength":1,"maxLength":128},"resolvedAt":{"type":"string","format":"date-time"},"supersededBy":{"type":"string","maxLength":200},"reason":{"type":"object","required":["code"],"additionalProperties":false,"properties":{"code":{"type":"string","enum":["withdrawn","policy","record_changed","record_deleted","permission_changed","stopped","other"]},"text":{"type":"string","maxLength":200}}},"note":{"$ref":"#/$defs/text"}},"allOf":[{"if":{"properties":{"status":{"const":"resolved"}},"required":["status"]},"then":{"required":["resolvedAt"]}},{"if":{"properties":{"status":{"const":"cancelled"}},"required":["status"]},"then":{"required":["reason"]}},{"if":{"properties":{"status":{"enum":["cancelled","expired","superseded"]}},"required":["status"]},"then":{"not":{"required":["resolvedBy"]}}},{"if":{"properties":{"status":{"enum":["open","resolved"]}},"required":["status"]},"then":{"not":{"required":["reason"]}}},{"if":{"properties":{"status":{"const":"resolved"}},"required":["status"]},"then":{"oneOf":[{"required":["selected"],"not":{"anyOf":[{"required":["outcome"]},{"required":["values"]},{"required":["freeText"]}]}},{"required":["outcome"],"not":{"anyOf":[{"required":["selected"]},{"required":["values"]},{"required":["freeText"]}]}},{"required":["values"],"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]},{"required":["freeText"]}]}},{"required":["freeText"],"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]},{"required":["values"]}]}}]},"else":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]},{"required":["values"]},{"required":["freeText"]},{"required":["resolvedAt"]},{"required":["resolvedBy"]}]}}},{"if":{"properties":{"status":{"const":"superseded"}},"required":["status"]},"then":{"required":["supersededBy"]},"else":{"not":{"required":["supersededBy"]}}}]},"markdownData":{"type":"object","required":["text"],"additionalProperties":false,"properties":{"text":{"type":"string","maxLength":32768}}},"timeSeriesData":{"type":"object","required":["xType","series"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xType":{"type":"string","enum":["date","datetime","number","category"]},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"yUnit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"series":{"type":"array","minItems":1,"maxItems":6,"items":{"type":"object","required":["key","label","points"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"points":{"type":"array","maxItems":500,"items":{"type":"object","required":["x","y"],"additionalProperties":false,"properties":{"x":{"type":["string","number"],"maxLength":64},"y":{"type":["number","null"]}}}}}}},"summary":{"$ref":"#/$defs/text"}}},"breakdownData":{"type":"object","required":["parts"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"parts":{"type":"array","minItems":2,"maxItems":12,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":"number","minimum":0},"mergedCount":{"type":"integer","minimum":2}}}},"asOf":{"$ref":"#/$defs/temporal"},"summary":{"$ref":"#/$defs/text"}}},"categorySeriesData":{"type":"object","required":["points"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"points":{"type":"array","minItems":1,"maxItems":24,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":["number","null"]},"assessment":{"$ref":"#/$defs/assessment"}}}},"reference":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"type":"number"}}},"summary":{"$ref":"#/$defs/text"}}},"option":{"type":"object","required":["id","label"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"label":{"$ref":"#/$defs/label"},"description":{"$ref":"#/$defs/text"}}},"choiceData":{"type":"object","required":["prompt","options","action"],"additionalProperties":false,"properties":{"prompt":{"$ref":"#/$defs/text"},"options":{"type":"array","minItems":2,"maxItems":10,"items":{"$ref":"#/$defs/option"}},"selection":{"type":"string","enum":["single","multiple"]},"minSelect":{"type":"integer","minimum":0,"maximum":10},"maxSelect":{"type":"integer","minimum":1,"maximum":10},"allowFreeText":{"type":"boolean"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"choice.select"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["outcome"]},{"required":["values"]}]}}}}]},"confirmationData":{"type":"object","required":["title","severity","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"body":{"$ref":"#/$defs/text"},"severity":{"type":"string","enum":["normal","destructive"]},"details":{"type":"array","maxItems":12,"items":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"$ref":"#/$defs/scalar"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"}}}},"confirmLabel":{"$ref":"#/$defs/shortLabel"},"cancelLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"confirmation.respond"}}}]},"state":{"$ref":"#/$defs/blockState"}},"if":{"properties":{"action":{"properties":{"requiresConfirmation":{"const":true}},"required":["requiresConfirmation"]}}},"then":{"properties":{"severity":{"const":"destructive"}}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["values"]}]}}}}]},"formField":{"type":"object","required":["key","label","type"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"type":{"type":"string","enum":["text","multiline_text","number","integer","date","datetime","boolean","single_select","multi_select"]},"required":{"type":"boolean"},"options":{"type":"array","maxItems":20,"items":{"$ref":"#/$defs/option"}},"min":{"type":"number"},"max":{"type":"number"},"maxLength":{"type":"integer","minimum":1,"maximum":2000},"unit":{"$ref":"#/$defs/unit"},"placeholder":{"$ref":"#/$defs/label"},"help":{"$ref":"#/$defs/text"},"defaultValue":{"anyOf":[{"$ref":"#/$defs/scalar"},{"type":"array","maxItems":20,"items":{"type":"string","maxLength":64}}]}},"allOf":[{"if":{"properties":{"type":{"enum":["single_select","multi_select"]}}},"then":{"required":["options"],"properties":{"options":{"minItems":1}}}}]},"formIntentData":{"type":"object","required":["fields","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"purpose":{"$ref":"#/$defs/text"},"fields":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/formField"}},"submitLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"form.submit"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]}]}}}}]}}};
const ACTION_SCHEMA = {"$defs":{"messageId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"},"blockId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"optionId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"actionId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$"},"actionType":{"type":"string","enum":["choice.select","confirmation.respond","form.submit"]},"target":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){0,3}$","maxLength":64},"actionSpec":{"type":"object","required":["type","target"],"additionalProperties":false,"properties":{"type":{"$ref":"#/$defs/actionType"},"target":{"$ref":"#/$defs/target"},"requiresConfirmation":{"type":"boolean"},"expiresAt":{"type":"string","format":"date-time"}},"if":{"properties":{"requiresConfirmation":{"const":true}},"required":["requiresConfirmation"]},"then":{"properties":{"type":{"const":"confirmation.respond"}}}},"actionContext":{"type":"object","required":["messageId","blockId"],"additionalProperties":false,"properties":{"conversationId":{"$ref":"#/$defs/messageId"},"messageId":{"$ref":"#/$defs/messageId"},"blockId":{"$ref":"#/$defs/blockId"}}},"choiceSelectPayload":{"type":"object","additionalProperties":false,"properties":{"selected":{"type":"array","items":{"$ref":"#/$defs/optionId"},"minItems":1,"maxItems":10,"uniqueItems":true},"freeText":{"$ref":"#/$defs/freeText"}},"oneOf":[{"required":["selected"]},{"required":["freeText"]}]},"freeText":{"type":"string","minLength":1,"maxLength":500},"confirmationRespondPayload":{"type":"object","additionalProperties":false,"properties":{"outcome":{"type":"string","enum":["confirm","cancel"]},"freeText":{"$ref":"#/$defs/freeText"}},"oneOf":[{"required":["outcome"]},{"required":["freeText"]}]},"formSubmitPayload":{"type":"object","additionalProperties":false,"oneOf":[{"required":["values"]},{"required":["freeText"]}],"properties":{"freeText":{"$ref":"#/$defs/freeText"},"values":{"type":"object","maxProperties":12,"propertyNames":{"pattern":"^[a-z][a-z0-9_]{0,31}$"},"additionalProperties":{"anyOf":[{"type":["string","number","boolean","null"],"maxLength":2000},{"type":"array","maxItems":20,"items":{"type":"string","maxLength":64}}]}}}},"actionRequest":{"type":"object","required":["id","protocolVersion","type","target","context","payload"],"additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/actionId"},"protocolVersion":{"type":"string","pattern":"^[0-9]+\\.[0-9]+$"},"type":{"$ref":"#/$defs/actionType"},"target":{"$ref":"#/$defs/target"},"context":{"$ref":"#/$defs/actionContext"},"payload":{"type":"object"},"clientTs":{"type":"string","format":"date-time"}},"allOf":[{"if":{"properties":{"type":{"const":"choice.select"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/choiceSelectPayload"}}}},{"if":{"properties":{"type":{"const":"confirmation.respond"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/confirmationRespondPayload"}}}},{"if":{"properties":{"type":{"const":"form.submit"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/formSubmitPayload"}}}}]}}};

export const COMPONENT_CATALOG = [
  {
    "type": "markdown",
    "useWhen": "Use plain Markdown for ordinary explanations, short answers, steps and code. Keep tables as Markdown tables; use a chart only when it improves understanding.",
    "schemaVersion": 1,
    "dataSchema": "markdownData",
    "interactive": false,
    "description": "Text content. Use data.text for Markdown; keep the envelope fallback readable without a renderer.",
    "example": {
      "version": 1,
      "kind": "message",
      "messageId": "markdown_message",
      "fallbackText": "部署已完成：3 个服务都在运行，没有报错。",
      "blocks": [
        {
          "id": "text",
          "type": "markdown",
          "schemaVersion": 1,
          "data": {
            "text": "部署已完成：**3 个服务**都在运行，没有报错。"
          }
        }
      ]
    }
  },
  {
    "type": "time_series",
    "useWhen": "Use for time trends when at least two dated or ordered measurements are available, such as daily usage. Include one or two sentences explaining the takeaway; do not send only a chart or invent missing data.",
    "schemaVersion": 1,
    "dataSchema": "timeSeriesData",
    "interactive": false,
    "description": "A bounded series chart with xType and one to six labeled series; each series has at most 500 x/y points. For xType date, write each x as YYYY-MM-DD (recommended); epoch milliseconds and date-times with Z or an offset are shown on their calendar day in the agent instance time zone (TZ in .env).",
    "example": {
      "version": 1,
      "kind": "message",
      "messageId": "chart_message",
      "fallbackText": "近两天用量：11-01 为 1，11-02 暂无数据。",
      "blocks": [
        {
          "id": "chart",
          "type": "time_series",
          "schemaVersion": 1,
          "data": {
            "xType": "date",
            "series": [
              {
                "key": "usage",
                "label": "用量",
                "points": [
                  {
                    "x": "2026-11-01",
                    "y": 1
                  },
                  {
                    "x": "2026-11-02",
                    "y": null
                  }
                ]
              }
            ]
          },
          "fallbackText": "用量图：首日1，次日未知"
        }
      ]
    }
  },
  {
    "type": "breakdown",
    "useWhen": "Use for part-to-whole shares when two to twelve nonnegative parts of a meaningful total are available, such as PR shares by status. Include one or two sentences explaining the takeaway; do not send only a chart or invent values.",
    "schemaVersion": 1,
    "dataSchema": "breakdownData",
    "interactive": false,
    "description": "A nonnegative breakdown with two to twelve keyed, labeled parts.",
    "example": {
      "version": 1,
      "kind": "message",
      "messageId": "breakdown_message",
      "fallbackText": "构成：甲 2（40%），乙 3（60%），共 5。",
      "blocks": [
        {
          "id": "parts",
          "type": "breakdown",
          "schemaVersion": 1,
          "data": {
            "parts": [
              {
                "key": "a",
                "label": "甲",
                "value": 2
              },
              {
                "key": "b",
                "label": "乙",
                "value": 3
              }
            ]
          },
          "fallbackText": "甲2，乙3"
        }
      ]
    }
  },
  {
    "type": "category_series",
    "useWhen": "Use to compare one to twenty-four categories with known values, such as PR counts by status. Include one or two sentences explaining the takeaway; do not send only a chart or invent values.",
    "schemaVersion": 1,
    "dataSchema": "categorySeriesData",
    "interactive": false,
    "description": "One to twenty-four keyed, labeled category values, including signed numbers or null for unavailable values. yLabel names the numeric value axis, shown below horizontal bars; category labels identify each row.",
    "example": {
      "version": 1,
      "kind": "message",
      "messageId": "category_message",
      "fallbackText": "分类对比：甲为 0，乙暂无数据。",
      "blocks": [
        {
          "id": "categories",
          "type": "category_series",
          "schemaVersion": 1,
          "data": {
            "points": [
              {
                "key": "a",
                "label": "甲",
                "value": 0
              },
              {
                "key": "b",
                "label": "乙",
                "value": null
              }
            ]
          },
          "fallbackText": "甲0，乙未知"
        }
      ]
    }
  },
  {
    "type": "choice",
    "useWhen": "Use when the user needs to select among two to ten concrete options, including choosing between proposed plans. Ask one clear question and wait for the answer; use Markdown when no user selection is needed.",
    "schemaVersion": 1,
    "dataSchema": "choiceData",
    "interactive": true,
    "description": "An explicit single- or multiple-choice question with two to ten options and a choice.select action. Selection constraints are validated against the saved question.",
    "example": {
      "version": 1,
      "kind": "message",
      "messageId": "single_question",
      "fallbackText": "选一个方案；等待用户回答。",
      "blocks": [
        {
          "id": "question",
          "type": "choice",
          "schemaVersion": 1,
          "data": {
            "prompt": "选一个方案",
            "options": [
              {
                "id": "a",
                "label": "方案甲"
              },
              {
                "id": "b",
                "label": "方案乙"
              }
            ],
            "action": {
              "type": "choice.select",
              "target": "clarification.answer"
            }
          },
          "fallbackText": "选一个方案"
        }
      ],
      "interruptId": "interrupt_single_question",
      "questionSummary": "选一个方案",
      "interrupt": {
        "blockId": "question",
        "reason": "input_required"
      }
    }
  },
  {
    "type": "confirmation",
    "useWhen": "Use to request explicit confirmation before a dangerous or irreversible operation, such as deleting a group. State the operation and its consequences, then wait for the user to answer before acting.",
    "schemaVersion": 1,
    "dataSchema": "confirmationData",
    "interactive": true,
    "description": "An explicit confirm/cancel question with a confirmation.respond action. An action marked requiresConfirmation must use destructive severity.",
    "example": {
      "version": 1,
      "kind": "message",
      "messageId": "confirmation_question",
      "fallbackText": "确认执行？；等待用户回答。",
      "blocks": [
        {
          "id": "question",
          "type": "confirmation",
          "schemaVersion": 1,
          "data": {
            "title": "确认执行？",
            "severity": "destructive",
            "action": {
              "type": "confirmation.respond",
              "target": "operation.confirm",
              "requiresConfirmation": true
            }
          },
          "fallbackText": "确认执行？"
        }
      ],
      "interruptId": "interrupt_confirmation_question",
      "questionSummary": "确认执行？",
      "interrupt": {
        "blockId": "question",
        "reason": "confirmation"
      }
    }
  },
  {
    "type": "form_intent",
    "useWhen": "Use when the user needs to provide multiple related fields together. Ask only for needed information; use a short Markdown question for a single simple detail.",
    "schemaVersion": 1,
    "dataSchema": "formIntentData",
    "interactive": true,
    "description": "A version-one form with one to twelve fields and a form.submit action. Fields may use text, multiline_text, number, integer, date, datetime, boolean, single_select or multi_select.",
    "example": {
      "version": 1,
      "kind": "message",
      "messageId": "form_question",
      "fallbackText": "登记信息；等待用户回答。",
      "blocks": [
        {
          "id": "question",
          "type": "form_intent",
          "schemaVersion": 1,
          "data": {
            "title": "登记信息",
            "fields": [
              {
                "key": "name",
                "label": "名字",
                "type": "text",
                "required": true,
                "maxLength": 20
              },
              {
                "key": "count",
                "label": "数量",
                "type": "integer",
                "min": 1,
                "max": 5
              },
              {
                "key": "tags",
                "label": "标签",
                "type": "multi_select",
                "options": [
                  {
                    "id": "a",
                    "label": "甲"
                  },
                  {
                    "id": "b",
                    "label": "乙"
                  }
                ]
              }
            ],
            "action": {
              "type": "form.submit",
              "target": "information.submit"
            }
          },
          "fallbackText": "登记信息"
        }
      ],
      "interruptId": "interrupt_form_question",
      "questionSummary": "登记信息",
      "interrupt": {
        "blockId": "question",
        "reason": "input_required"
      }
    }
  }
];

// Approved host definitions extend the fixed upstream v1 definitions above.
const HOST_SCHEMA_SOURCE = { designCommit: '74b653a', viewSchemaVersion: 1, formSchemaVersion: 2 };
const FORM_CONDITION_SCHEMA = {
  oneOf: [
    { type: 'object', required: ['field', 'eq'], additionalProperties: false,
      properties: { field: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' },
        eq: { type: ['string', 'number', 'boolean'] } } },
    { type: 'object', required: ['field', 'in'], additionalProperties: false,
      properties: { field: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' },
        in: { type: 'array', minItems: 1, maxItems: 20,
          items: { type: ['string', 'number', 'boolean'] } } } },
    { type: 'object', required: ['field', 'present'], additionalProperties: false,
      properties: { field: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' }, present: { const: true } } },
  ],
};
const nodeId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };
const childIds = { type: 'array', maxItems: 128, items: nodeId };
const VIEW_SCHEMA = {
  type: 'object', required: ['schemaVersion', 'root', 'nodes'], additionalProperties: false,
  properties: { schemaVersion: { const: 1 }, root: nodeId,
    nodes: { type: 'array', minItems: 1, maxItems: 128, items: { $ref: '#/$defs/node' } } },
  $defs: { node: { oneOf: [
    { type: 'object', required: ['id', 'type', 'children'], additionalProperties: false,
      properties: { id: nodeId, type: { const: 'stack' }, children: { ...childIds, minItems: 1 }, gap: { enum: ['compact', 'normal'] } } },
    { type: 'object', required: ['id', 'type', 'children'], additionalProperties: false,
      properties: { id: nodeId, type: { const: 'columns' }, children: { ...childIds, minItems: 2, maxItems: 4 }, layout: { enum: ['balanced', 'sidebar'] } },
      if: { properties: { layout: { const: 'sidebar' } }, required: ['layout'] },
      then: { properties: { children: { minItems: 2, maxItems: 2 } } } },
    { type: 'object', required: ['id', 'type'], additionalProperties: false,
      properties: { id: nodeId, type: { const: 'section' }, header: childIds, body: childIds, actions: childIds },
      anyOf: ['header', 'body', 'actions'].map(name => ({ required: [name], properties: { [name]: { minItems: 1 } } })) },
    { type: 'object', required: ['id', 'type', 'blockId'], additionalProperties: false,
      properties: { id: nodeId, type: { const: 'block' }, blockId: nodeId } },
  ] } },
};

function blockSchemaWithHostDefinitions() {
  const schema = clone(BLOCK_SCHEMA);
  schema.properties.type.enum.push('x-zylos.image', 'x-zylos.file');
  schema.properties.schemaVersion = { enum: [1, 2] };
  const formRule = schema.allOf.find(rule => rule.if?.properties?.type?.const === 'form_intent');
  formRule.if.properties.schemaVersion = { const: 1 };
  schema.allOf.push({ if: { properties: { schemaVersion: { const: 2 } } },
    then: { properties: { type: { const: 'form_intent' }, data: { $ref: '#/$defs/formIntentDataV2' } } } });
  schema.$defs.activeWhen = clone(FORM_CONDITION_SCHEMA);
  schema.$defs.formFieldV2 = clone(schema.$defs.formField);
  schema.$defs.formFieldV2.properties.activeWhen = { $ref: '#/$defs/activeWhen' };
  schema.$defs.formIntentDataV2 = clone(schema.$defs.formIntentData);
  schema.$defs.formIntentDataV2.properties.fields.items = { $ref: '#/$defs/formFieldV2' };
  schema.$defs.attachmentData = {
    type: 'object', required: ['attachmentId', 'nameSnapshot'], additionalProperties: false,
    // Match the existing attachment service's ID grammar and display-name cap.
    properties: { attachmentId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
      nameSnapshot: { type: 'string', minLength: 1, maxLength: 160 } },
  };
  for (const type of ['x-zylos.image', 'x-zylos.file']) {
    schema.allOf.push({ if: { properties: { type: { const: type } } },
      then: { required: ['data'], properties: { schemaVersion: { const: 1 }, status: { const: 'complete' },
        data: { $ref: '#/$defs/attachmentData' } } } });
  }
  return schema;
}

COMPONENT_CATALOG.push({ type: 'form_intent', schemaVersion: 2, dataSchema: 'formIntentDataV2', interactive: true,
  useWhen: 'Use when the user needs to provide multiple related fields and later questions depend on earlier answers. Ask only for needed information; use a short Markdown question for a single simple detail.',
  description: 'A conditional form. Field activeWhen uses scalar eq/in or present:true; hidden upstream values are missing downstream. Submit only active keys.',
  example: { version: 1, kind: 'message', messageId: 'conditional_form_question',
    fallbackText: '登记主体信息；等待用户回答。', blocks: [{ id: 'question', type: 'form_intent', schemaVersion: 2,
      data: { title: '登记主体信息', fields: [
        { key: 'customer_type', label: '主体类型', type: 'single_select', required: true,
          options: [{ id: 'person', label: '个人' }, { id: 'company', label: '企业' }] },
        { key: 'company_name', label: '公司名称', type: 'text', required: true,
          activeWhen: { field: 'customer_type', eq: 'company' } },
      ], action: { type: 'form.submit', target: 'information.submit' } }, fallbackText: '登记主体信息' }],
    interruptId: 'interrupt_conditional_form_question', questionSummary: '登记主体信息',
    interrupt: { blockId: 'question', reason: 'input_required' } },
});

for (const [kind, name] of [['image', 'diagram.png'], ['file', 'report.pdf']]) {
  COMPONENT_CATALOG.push({ type: `x-zylos.${kind}`, schemaVersion: 1, dataSchema: 'attachmentData', interactive: false,
    useWhen: `Use to share an existing registered ${kind} attachment when this Core lists the component as implemented.`,
    description: `A registered ${kind} attachment. Register on the target instance first; data contains only attachmentId and nameSnapshot. The ID does not grant download permission. Keep the filename and ID in fallbackText.`,
    example: { version: 1, kind: 'message', messageId: `attachment_${kind}_message`,
      fallbackText: `${name} (attachment att_${kind})`, blocks: [{ id: kind, type: `x-zylos.${kind}`, schemaVersion: 1,
        data: { attachmentId: `att_${kind}`, nameSnapshot: name }, fallbackText: `${name} (attachment att_${kind})` }] },
  });
}

// Static renderer implementations shipped with this Core version. A catalog
// entry alone is never an implementation claim. Rendering tests cover each key.
export const CORE_COMPONENT_KEYS = ['markdown@1', 'time_series@1', 'breakdown@1',
  'category_series@1', 'choice@1', 'confirmation@1', 'form_intent@1', 'form_intent@2'];
const clone = value => JSON.parse(JSON.stringify(value));

export function createCatalogArtifacts({ implementedKeys = CORE_COMPONENT_KEYS } = {}) {
  const available = new Set(implementedKeys);
  const blockSchema = blockSchemaWithHostDefinitions();
  const definitions = COMPONENT_CATALOG.map(component => ({
    key: `${component.type}@${component.schemaVersion}`, type: component.type,
    schemaVersion: component.schemaVersion, interactive: component.interactive,
    description: component.description, useWhen: component.useWhen,
    parameters: clone(blockSchema.$defs[component.dataSchema]), example: clone(component.example),
  }));
  const registered = definitions.filter(component => available.has(component.key));
  const instructions = [
    'C4 version 1; ChatWeave protocol 0.1. Use only the components listed below.',
    'Send the complete example envelope with the exact [C4-JSON] marker followed by a newline.',
    'Replace example values while preserving field constraints. Every non-markdown block needs fallbackText. Write fallbackText as the real message in plain words, not a placeholder: it is what channels without a renderer show.',
    'A stored C4 message is never updated in place: a block with status pending stays pending, so send a complete block in a later message instead. Omit action.expiresAt: the host neither displays nor enforces it, and a late answer to an open question is still accepted.',
    'Interactive messages need the matching interrupt and summary. questionSummary must equal makeQuestionSummary(envelope): use the interrupted block\'s first nonempty string from fallbackText, data.prompt, data.title, data.purpose, then the envelope fallbackText; collapse whitespace to single spaces, trim, and keep the first 500 Unicode characters. Actions are checked against the stored question.',
    'Parameter references resolve against BLOCK_SCHEMA.$defs or ACTION_SCHEMA.$defs in the same schema module.',
    ...registered.map(component => `${component.key}: ${component.description}\nWhen to use: ${component.useWhen}\nParameters: ${JSON.stringify(component.parameters)}`),
  ].join('\n\n');
  return { BLOCK_SCHEMA: blockSchema, ACTION_SCHEMA: clone(ACTION_SCHEMA),
    CATALOG_SOURCE: clone(CATALOG_SOURCE), HOST_SCHEMA_SOURCE: clone(HOST_SCHEMA_SOURCE),
    VIEW_SCHEMA: clone(VIEW_SCHEMA), FORM_CONDITION_SCHEMA: clone(FORM_CONDITION_SCHEMA), COMPONENT_DEFINITIONS: registered,
    INTERACTIVE_COMPONENT_TYPES: [...new Set(COMPONENT_CATALOG.filter(component => component.interactive).map(component => component.type))],
    REGISTERED_COMPONENT_KEYS: registered.map(component => component.key), MODEL_INSTRUCTIONS: instructions };
}
