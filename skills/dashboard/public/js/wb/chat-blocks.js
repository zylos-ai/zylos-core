import { parseC4Content, REGISTERED_COMPONENT_KEYS } from '../../chat-schema.js?v=104';
import { element } from './plain-text.js?v=106';
import { attachmentDisplayText } from './chat-attachments.js?v=152';
import { formatDuration } from './duration-format.js?v=1';

export { parseC4Content };
export { validateAnswer } from '../../chat-schema.js?v=104';

const interactive = new Set(['choice', 'confirmation', 'form_intent']);

/** Render the validated shared protocol as inert DOM; the host owns answers. */
export function renderChatContent({ document, row, t = key => key, renderQuestion, supportsBlock, renderChart, renderAttachment, external = false, layout, showTechnicalDetails = true } = {}) {
  const node = (tag, text, cls) => element(document, tag, text, cls);
  const root = node('div', undefined, 'chat-message-content');
  const reference = () => {
    const label = node('span', `${t('chat.block.reference')} ${String(row.id)}`, 'chat-block-reference');
    label.hidden = !showTechnicalDetails;
    return label;
  };
  const error = fallbackText => {
    const result = node('div', undefined, 'chat-block-error');
    result.setAttribute('role', 'note');
    if (fallbackText !== undefined) result.append(node('p', fallbackText, 'chat-invalid-fallback'));
    result.append(node('p', t(fallbackText === undefined ? 'chat.invalidContent' : 'chat.partialContent'), fallbackText === undefined ? 'chat-error' : 'chat-notice'), reference());
    return result;
  };
  const parsed = parseC4Content(row.content);
  if (parsed.kind === 'text') {
    const body = attachmentDisplayText(parsed.text, { external, t });
    if (body) root.append(node('p', body, 'chat-message-text'));
    for (const [attachmentIndex, attachment] of (Array.isArray(row.attachments) ? row.attachments.slice(0, 20) : []).entries()) {
      const rendered = renderAttachment?.({ attachment, attachmentIndex, row });
      if (rendered) root.append(rendered);
      else root.append(node('p', `${t(attachment.kind === 'image' ? 'chat.attachment.image' : 'chat.attachment.file')} ${attachment.name || ''}`, 'chat-block-text'));
    }
    return root;
  }
  if (parsed.kind !== 'envelope') { root.append(error(parsed.fallbackText)); return root; }
  const envelope = parsed.envelope;
  if (envelope.kind !== 'message' || !envelope.blocks.length) {
    root.append(node('p', envelope.fallbackText, 'chat-message-text')); return root;
  }
  const text = (parent, value, cls = 'chat-block-text') => {
    if (value !== undefined && value !== '') parent.append(node('p', value, cls));
  };
  const value = (amount, unit, format) => {
    if (amount === null) return t('chat.block.noValue');
    if (typeof amount !== 'number') return String(amount);
    if (format?.style === 'duration') return formatDuration(amount, format.maximumFractionDigits, document.documentElement?.lang || undefined);
    let number = amount;
    const options = { maximumFractionDigits: format?.maximumFractionDigits ?? 6 };
    if (format?.style === 'integer') options.maximumFractionDigits = 0;
    if (format?.style === 'percent') options.style = 'percent';
    if (format?.style === 'currency' && format.currency) {
      options.style = 'currency'; options.currency = format.currency;
      if (format.minorUnits) number /= 10 ** new Intl.NumberFormat(undefined, { style: 'currency', currency: format.currency }).resolvedOptions().maximumFractionDigits;
    }
    const formatted = new Intl.NumberFormat(undefined, options).format(number);
    return unit ? `${formatted} ${unit}` : formatted;
  };
  function chart(block) {
    const data = block.data, figure = node('figure', undefined, 'chat-chart');
    if (data.title) figure.append(node('figcaption', data.title, 'chat-block-title'));
    const series = block.type === 'time_series' ? data.series : [{ label: data.yLabel ?? '', unit: data.unit,
      points: (data.parts ?? data.points).map(point => ({ x: point.label, y: point.value, assessment: point.assessment })) }];
    if (data.xLabel || data.yLabel) text(figure, [data.xLabel, data.yLabel].filter(Boolean).join(' · '), 'chat-chart-axes');
    for (const entry of series) {
      const section = node('div', undefined, 'chat-chart-series');
      if (entry.label) text(section, entry.label, 'chat-chart-series-label');
      const table = node('table', undefined, 'chat-chart-table');
      const scale = Math.max(0, ...entry.points.map(point => Math.abs(point.y ?? 0)));
      for (const point of entry.points) {
        const tr = node('tr');
        const label = node('th', String(point.x), 'chat-chart-label'); label.setAttribute('scope', 'row');
        const graphic = node('td', undefined, 'chat-chart-graphic'); graphic.setAttribute('aria-hidden', 'true');
        if (point.y !== null) {
          const bar = node('span', undefined, 'chat-chart-bar' + (point.y < 0 ? ' negative' : ''));
          bar.style.width = `${scale === 0 ? 0 : Math.abs(point.y) / scale * 100}%`; graphic.append(bar);
        }
        const amount = node('td', value(point.y, entry.unit ?? data.yUnit, data.format), 'chat-chart-value');
        tr.append(label, graphic, amount); table.append(tr);
        if (point.assessment) {
          const assessment = node('tr'), detail = node('td', [point.assessment.label, point.assessment.detail].filter(Boolean).join(' · '));
          detail.setAttribute('colspan', '3'); assessment.append(detail); table.append(assessment);
        }
      }
      section.append(table); figure.append(section);
    }
    if (data.reference) text(figure, `${data.reference.label}: ${value(data.reference.value, data.unit, data.format)}`, 'chat-chart-baseline');
    if (data.asOf) text(figure, data.asOf, 'chat-block-asof');
    text(figure, data.summary);
    return figure;
  }
  function staticQuestion(block, { showChoiceOptions = true, showFormFields = true } = {}) {
    const part = node('div', undefined, 'chat-question-description'), data = block.data;
    if (block.type === 'choice') {
      text(part, data.prompt, 'chat-block-title');
      if (showChoiceOptions) {
        const list = node('ul', undefined, 'chat-choice-options');
        for (const option of data.options) {
          const item = node('li'); item.append(node('span', option.label)); text(item, option.description); list.append(item);
        }
        part.append(list);
      }
    } else if (block.type === 'confirmation') {
      text(part, data.title, 'chat-block-title'); text(part, data.body);
      if (data.details?.length) {
        const list = node('dl', undefined, 'chat-confirmation-details');
        for (const detail of data.details) list.append(node('dt', detail.label), node('dd', value(detail.value, detail.unit, detail.format)));
        part.append(list);
      }
    } else {
      text(part, data.title, 'chat-block-title'); text(part, data.purpose);
      const list = node('dl', undefined, 'chat-form-fields');
      for (const field of data.fields) {
        list.append(node('dt', field.label));
        const detail = node('dd');
        text(detail, field.help);
        if (field.options) text(detail, field.options.map(option => option.label).join(' · '));
        if (field.unit) text(detail, field.unit);
        list.append(detail);
      }
      if (showFormFields) part.append(list);
    }
    const state = data.state;
    if (state && state.status !== 'open') {
      text(part, t('chat.block.state.' + state.status), 'chat-question-status');
      if (state.status === 'resolved') {
        if (state.freeText !== undefined) text(part, state.freeText);
        else if (block.type === 'choice') text(part, state.selected.map(id => data.options.find(option => option.id === id)?.label ?? id).join(' · '));
        else if (block.type === 'confirmation') text(part, state.outcome === 'confirm' ? data.confirmLabel || t('chat.question.confirm') : data.cancelLabel || t('chat.question.cancel'));
        else {
          const result = node('dl', undefined, 'chat-form-fields');
          for (const field of data.fields) if (Object.hasOwn(state.values, field.key)) {
            const saved = state.values[field.key];
            const label = selected => field.options?.find(option => option.id === selected)?.label ?? String(selected);
            const shown = saved === null ? t('chat.block.noValue') : field.type === 'boolean' ? t(saved ? 'chat.block.yes' : 'chat.block.no')
              : field.type === 'single_select' ? label(saved) : Array.isArray(saved) ? saved.map(label).join(' · ') : String(saved);
            result.append(node('dt', field.label), node('dd', shown));
          }
          part.append(result);
        }
      } else if (state.reason?.text) text(part, state.reason.text);
    }
    return part;
  }
  const blockNodes = new Map();
  for (const block of envelope.blocks) {
    try {
      const part = node('section', undefined, 'chat-block chat-block-' + block.type);
      part.dataset.blockId = block.id; part.dataset.blockType = block.type;
      if (block.type === 'confirmation' && block.data) part.dataset.severity = block.data.severity;
      if (block.status === 'error' || block.status === 'pending') {
        text(part, block.fallbackText);
        if (block.status === 'error') {
          if (block.reason) text(part, block.reason, 'chat-error');
          if (!block.fallbackText && !block.reason) text(part, t('chat.block.failed'), 'chat-error');
          part.append(reference());
        }
        else text(part, t('chat.block.pending'), 'chat-message-status');
      } else if ((!REGISTERED_COMPONENT_KEYS.includes(`${block.type}@${block.schemaVersion}`)
        && !(renderAttachment && block.schemaVersion === 1 && ['x-zylos.image', 'x-zylos.file'].includes(block.type))) || supportsBlock?.(block) === false) {
        text(part, block.fallbackText || envelope.fallbackText);
      } else if (block.type === 'markdown') text(part, block.data.text || block.fallbackText || envelope.fallbackText, 'chat-message-text');
      else if (['x-zylos.image', 'x-zylos.file'].includes(block.type)) {
        const attachment = (Array.isArray(row.attachments) ? row.attachments : []).find(item => item.id === block.data.attachmentId);
        const fallback = { name: block.data.nameSnapshot, kind: block.type === 'x-zylos.image' ? 'image' : 'file', available: false };
        const rendered = renderAttachment?.({ attachment: attachment || fallback, block, row });
        if (rendered) part.append(rendered);
        else text(part, block.fallbackText || envelope.fallbackText);
      }
      else if (['time_series', 'breakdown', 'category_series'].includes(block.type)) {
        const fallback = chart(block);
        part.append(renderChart?.({ block, fallback }) ?? fallback);
      }
      else if (interactive.has(block.type)) {
        let question;
        if (renderQuestion && envelope.interrupt?.blockId === block.id) {
          question = renderQuestion({ envelope, block, row });
        }
        part.append(staticQuestion(block, { showChoiceOptions: question?.dataset.choiceControls !== 'true', showFormFields: question?.dataset.formControls !== 'true' }));
        if (question) part.append(question);
      } else text(part, block.fallbackText || envelope.fallbackText);
      // References are labels only: even valid URI schemes do not grant execution.
      if (block.metadata?.citations?.length) {
        const citations = node('ul', undefined, 'chat-block-citations');
        for (const citation of block.metadata.citations) citations.append(node('li', [citation.label, citation.ref, citation.url].filter(Boolean).join(' · ')));
        part.append(citations);
      }
      root.append(part);
      blockNodes.set(block.id, part);
    } catch {
      const failed = error();
      root.append(failed);
      blockNodes.set(block.id, failed);
    }
  }
  if (parsed.view && layout) layout(root, parsed.view, blockNodes);
  return root;
}
