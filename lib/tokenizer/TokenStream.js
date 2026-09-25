import { adoptBuffer } from './adopt-buffer.js';
import { cmpStr } from './utils.js';
import tokenNames from './names.js';
import {
    WhiteSpace,
    Comment,
    Delim,
    EOF,
    Function as FunctionToken,
    LeftParenthesis,
    RightParenthesis,
    LeftSquareBracket,
    RightSquareBracket,
    LeftCurlyBracket,
    RightCurlyBracket
} from './types.js';

const OFFSET_MASK = 0x00FFFFFF;
const TYPE_SHIFT = 24;
const balancePair = new Map([
    [FunctionToken, RightParenthesis],
    [LeftParenthesis, RightParenthesis],
    [LeftSquareBracket, RightSquareBracket],
    [LeftCurlyBracket, RightCurlyBracket]
]);

export class TokenStream {
    constructor(source, tokenize) {
        this.setSource(source, tokenize);
    }
    reset() {
        this.eof = false;
        this.tokenIndex = -1;
        this.tokenType = 0;
        this.tokenStart = this.firstCharOffset;
        this.tokenEnd = this.firstCharOffset;
    }
    setSource(source = '', tokenize = () => {}) {
        source = String(source || '');

        const sourceLength = source.length;
        const offsetAndType = adoptBuffer(this.offsetAndType, source.length + 1); // +1 because of eof-token
        const balance = adoptBuffer(this.balance, source.length + 1);
        // A strict LIFO stack of unclosed opening brackets.
        // balanceStartStash stores opener token indices, balanceCloseStash the
        // closing token type expected for each opener. TypedArrays avoid
        // per-token boxing; sized for one token per source char (worst case)
        const balanceStartStash = adoptBuffer(this.balanceStartStash, source.length + 1);
        const balanceCloseStash = adoptBuffer(this.balanceCloseStash, source.length + 1);
        let balanceStackLength = 0;
        let tokenCount = 0;
        let firstCharOffset = -1;

        // capture buffers
        this.offsetAndType = null;
        this.balance = null;
        this.balanceStartStash = balanceStartStash;
        this.balanceCloseStash = balanceCloseStash;

        tokenize(source, (type, start, end) => {
            // Only bracket tokens get meaningful links here:
            //  - an opening bracket is pushed and (on finalize) points to its
            //    matching closing bracket or the <EOF-token> when unclosed,
            //  - a matching closing bracket points back to its opener.
            // Regular tokens and mismatched closing brackets get the temporary
            // sourceLength value. A closing bracket that doesn't match the
            // opener on top of the stack is a parse error and per spec is
            // discarded without closing any bracket, so the stack is left
            // untouched and the token falls through to the default value
            // https://drafts.csswg.org/css-syntax/#parse-error
            if (balancePair.has(type)) {
                // an opening bracket: push it on top of the stack
                balance[tokenCount] = sourceLength;
                balanceStartStash[balanceStackLength] = tokenCount;
                balanceCloseStash[balanceStackLength] = balancePair.get(type);
                balanceStackLength++;
            } else if (balanceCloseStash[balanceStackLength - 1] === type) {
                // a closing bracket matching the opener on top of the stack:
                // link the opener to the close and the close back to the opener
                balance[tokenCount] = balanceStartStash[--balanceStackLength];
                balance[balance[tokenCount]] = tokenCount;
            } else {
                // a regular token or a mismatched (discarded) closing bracket
                balance[tokenCount] = sourceLength;
            }

            offsetAndType[tokenCount++] = (type << TYPE_SHIFT) | end;
            if (firstCharOffset === -1) {
                firstCharOffset = start;
            }
        });

        // finalize buffers
        offsetAndType[tokenCount] = (EOF << TYPE_SHIFT) | sourceLength; // <EOF-token>
        // Fill the block-end value for every unmatched token (regular tokens,
        // unclosed openers and discarded closing brackets): the index of the
        // closing bracket of the innermost enclosing pair, or the <EOF-token>.
        // Matched openers already link to their close (value > index) and
        // closes link back to their opener (value < index). Scan right-to-left
        // keeping a stack of block ends: a matched close pushes its index,
        // its matching opener pops it, and every other token is filled with
        // the current block end. Each token is visited once, so the pass is O(n).
        // The <EOF-token> entry is set explicitly because buffers are reused
        // and the callback never writes that slot
        {
            // stack of block ends, one entry per currently-open pair while
            // scanning right-to-left; entry 0 is the outer (<EOF-token>) end
            const blockEndStash = adoptBuffer(this.blockEndStash, source.length + 1);
            let depth = 0;

            blockEndStash[0] = tokenCount;
            for (let i = tokenCount - 1; i >= 0; i--) {
                const value = balance[i];

                if (value < i) {
                    // a matched closing bracket, value is the opener index:
                    // everything up to its opener belongs to this pair
                    blockEndStash[++depth] = i; // close keeps linking back to the opener
                } else if (value > i && value !== sourceLength) {
                    // a matched opener (value is its close index): leave the pair
                    depth--; // opener keeps linking to the close
                } else {
                    balance[i] = blockEndStash[depth];
                }
            }
            balance[tokenCount] = tokenCount;
            this.blockEndStash = blockEndStash;
        }

        this.source = source;
        this.firstCharOffset = firstCharOffset === -1 ? 0 : firstCharOffset;
        this.tokenCount = tokenCount;
        this.offsetAndType = offsetAndType;
        this.balance = balance;

        this.reset();
        this.next();
    }

    lookupType(offset) {
        offset += this.tokenIndex;

        if (offset < this.tokenCount) {
            return this.offsetAndType[offset] >> TYPE_SHIFT;
        }

        return EOF;
    }
    lookupTypeNonSC(idx) {
        for (let offset = this.tokenIndex; offset < this.tokenCount; offset++) {
            const tokenType = this.offsetAndType[offset] >> TYPE_SHIFT;

            if (tokenType !== WhiteSpace && tokenType !== Comment) {
                if (idx-- === 0) {
                    return tokenType;
                }
            }
        }

        return EOF;
    }
    lookupOffset(offset) {
        offset += this.tokenIndex;

        if (offset < this.tokenCount) {
            return this.offsetAndType[offset - 1] & OFFSET_MASK;
        }

        return this.source.length;
    }
    lookupOffsetNonSC(idx) {
        for (let offset = this.tokenIndex; offset < this.tokenCount; offset++) {
            const tokenType = this.offsetAndType[offset] >> TYPE_SHIFT;

            if (tokenType !== WhiteSpace && tokenType !== Comment) {
                if (idx-- === 0) {
                    return offset - this.tokenIndex;
                }
            }
        }

        return EOF;
    }
    lookupValue(offset, referenceStr) {
        offset += this.tokenIndex;

        if (offset < this.tokenCount) {
            return cmpStr(
                this.source,
                this.offsetAndType[offset - 1] & OFFSET_MASK,
                this.offsetAndType[offset] & OFFSET_MASK,
                referenceStr
            );
        }

        return false;
    }
    getTokenStart(tokenIndex) {
        if (tokenIndex === this.tokenIndex) {
            return this.tokenStart;
        }

        if (tokenIndex > 0) {
            return tokenIndex < this.tokenCount
                ? this.offsetAndType[tokenIndex - 1] & OFFSET_MASK
                : this.offsetAndType[this.tokenCount] & OFFSET_MASK;
        }

        return this.firstCharOffset;
    }
    substrToCursor(start) {
        return this.source.substring(start, this.tokenStart);
    }

    isBalanceEdge(pos) {
        return this.balance[this.tokenIndex] < pos;
    }
    isDelim(code, offset) {
        if (offset) {
            return (
                this.lookupType(offset) === Delim &&
                this.source.charCodeAt(this.lookupOffset(offset)) === code
            );
        }

        return (
            this.tokenType === Delim &&
            this.source.charCodeAt(this.tokenStart) === code
        );
    }

    skip(tokenCount) {
        let next = this.tokenIndex + tokenCount;

        if (next < this.tokenCount) {
            this.tokenIndex = next;
            this.tokenStart = this.offsetAndType[next - 1] & OFFSET_MASK;
            next = this.offsetAndType[next];
            this.tokenType = next >> TYPE_SHIFT;
            this.tokenEnd = next & OFFSET_MASK;
        } else {
            this.tokenIndex = this.tokenCount;
            this.next();
        }
    }
    next() {
        let next = this.tokenIndex + 1;

        if (next < this.tokenCount) {
            this.tokenIndex = next;
            this.tokenStart = this.tokenEnd;
            next = this.offsetAndType[next];
            this.tokenType = next >> TYPE_SHIFT;
            this.tokenEnd = next & OFFSET_MASK;
        } else {
            this.eof = true;
            this.tokenIndex = this.tokenCount;
            this.tokenType = EOF;
            this.tokenStart = this.tokenEnd = this.source.length;
        }
    }
    skipSC() {
        while (this.tokenType === WhiteSpace || this.tokenType === Comment) {
            this.next();
        }
    }
    skipUntilBalanced(startToken, stopConsume) {
        let cursor = startToken;
        let balanceEnd;
        let offset;

        loop:
        for (; cursor < this.tokenCount; cursor++) {
            balanceEnd = this.balance[cursor];

            // stop scanning on balance edge that points to offset before start token
            if (balanceEnd < startToken) {
                break loop;
            }

            offset = cursor > 0 ? this.offsetAndType[cursor - 1] & OFFSET_MASK : this.firstCharOffset;

            // check stop condition
            switch (stopConsume(this.source.charCodeAt(offset))) {
                case 1: // just stop
                    break loop;

                case 2: // stop & included
                    cursor++;
                    break loop;

                default:
                    // fast forward when the cursor is on an opening bracket:
                    //  - a matched opener jumps to its matching closing bracket
                    //    (the close links back to the opener),
                    //  - an unclosed opener (its balance is the <EOF-token>)
                    //    jumps to the end of input, so stop tokens (e.g. ";" or
                    //    "}") can't terminate a value started inside the block
                    if (balancePair.has(this.offsetAndType[cursor] >> TYPE_SHIFT) &&
                        (balanceEnd === this.tokenCount || this.balance[balanceEnd] === cursor)) {
                        cursor = balanceEnd;
                    }
            }
        }

        this.skip(cursor - this.tokenIndex);
    }

    forEachToken(fn) {
        for (let i = 0, offset = this.firstCharOffset; i < this.tokenCount; i++) {
            const start = offset;
            const item = this.offsetAndType[i];
            const end = item & OFFSET_MASK;
            const type = item >> TYPE_SHIFT;

            offset = end;

            fn(type, start, end, i);
        }
    }
    dump() {
        const tokens = new Array(this.tokenCount);

        this.forEachToken((type, start, end, index) => {
            tokens[index] = {
                idx: index,
                type: tokenNames[type],
                chunk: this.source.substring(start, end),
                balance: this.balance[index]
            };
        });

        return tokens;
    }
};
