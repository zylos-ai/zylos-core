// Vendored from markdown-it-cjk-friendly@3.0.0; MIT license in LICENSE.
import { eastAsianWidthType } from "./get-east-asian-width/index.js";
//#region src/index.ts
function isEmoji(uc) {
	return /^\p{Emoji_Presentation}/u.test(String.fromCodePoint(uc));
}
/**
* Check if `uc` is CJK. Deferred (returns `null`) if IVS.
*
* @param uc code point
* @returns `true` if `uc` is CJK, `false` if not, `null` if IVS
*/
function isCjkBase(uc) {
	if (uc < 4352) return false;
	switch (eastAsianWidthType(uc)) {
		case "fullwidth":
		case "halfwidth": return true;
		case "wide": return !isEmoji(uc);
		case "narrow": return false;
		case "ambiguous": return null;
		case "neutral": return /^\p{sc=Hangul}/u.test(String.fromCodePoint(uc));
	}
}
function is2PreviousCjk(uc, prev) {
	return isCjkBase(uc) ?? (prev === 65025 && isQuotationMark(uc));
	function isQuotationMark(uc) {
		return uc === 8216 || uc === 8217 || uc === 8220 || uc === 8221;
	}
}
function isPreviousCjk(uc) {
	return isCjkBase(uc) ?? (917760 <= uc && uc <= 917999);
}
function isNextCjk(uc) {
	return isCjkBase(uc) ?? false;
}
function nonEmojiGeneralUseVS(uc) {
	return uc >= 65024 && uc <= 65038;
}
function markdownItCjkFriendlyPlugin(md) {
	const PreviousState = md.inline.State;
	class CjkFriendlyState extends PreviousState {
		scanDelims(start, canSplitWord) {
			const max = this.posMax;
			const marker = this.src.charCodeAt(start);
			const [lastChar, lastCharPos] = getLastCharCode(this.src, start);
			let lastMainChar = lastChar;
			let twoPrevChar = null;
			if (nonEmojiGeneralUseVS(lastChar)) {
				twoPrevChar = getLastCharCode(this.src, lastCharPos)[0];
				if (!/^\p{Zs}/u.test(String.fromCodePoint(twoPrevChar))) lastMainChar = twoPrevChar;
			}
			let pos = start;
			while (pos < max && this.src.charCodeAt(pos) === marker) pos++;
			const count = pos - start;
			const nextChar = pos < max ? this.src.codePointAt(pos) : 32;
			const isLastWhiteSpace = md.utils.isWhiteSpace(lastMainChar);
			const isNextWhiteSpace = md.utils.isWhiteSpace(nextChar);
			if (isLastWhiteSpace || isNextWhiteSpace) return {
				can_open: !isNextWhiteSpace,
				can_close: !isLastWhiteSpace,
				length: count
			};
			const isLastPunctChar = md.utils.isMdAsciiPunct(lastMainChar) || md.utils.isPunctChar(String.fromCodePoint(lastMainChar));
			const isNextPunctChar = md.utils.isMdAsciiPunct(nextChar) || md.utils.isPunctChar(String.fromCodePoint(nextChar));
			let left_flanking = isLastPunctChar;
			let right_flanking = isNextPunctChar;
			if (canSplitWord) {
				const isEitherCJKChar = isNextCjk(nextChar) || (twoPrevChar !== null ? is2PreviousCjk(twoPrevChar, lastChar) : isPreviousCjk(lastChar));
				left_flanking ||= isEitherCJKChar || !isNextPunctChar;
				right_flanking ||= isEitherCJKChar || !isLastPunctChar;
			}
			return {
				can_open: left_flanking,
				can_close: right_flanking,
				length: count
			};
			function getLastCharCode(str, pos) {
				if (pos <= 0) return [32, -1];
				const charCode = str.charCodeAt(pos - 1);
				if ((charCode & 64512) !== 56320) return [charCode, pos - 1];
				const codePoint = str.codePointAt(pos - 2);
				return codePoint > 65535 ? [codePoint, pos - 2] : [charCode, pos - 1];
			}
		}
	}
	md.inline.State = CjkFriendlyState;
}
//#endregion
export { markdownItCjkFriendlyPlugin as default };
