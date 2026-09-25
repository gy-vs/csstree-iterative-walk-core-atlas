import assert from 'assert';
import { TokenStream, tokenize, tokenNames } from 'css-tree';
import * as fixture from './fixture/tokenize.js';

describe('tokenize/stream', () => {
    const createStream = source => new TokenStream(source, tokenize);
    const css = '.test\n{\n  prop: url(foo/bar.jpg) url( a\\(\\33 \\).\\ \\"\\\'test ) calc(1 + 1) \\x \\aa ;\n}<!--<-->\\\n';
    const tokens = [
        { type: 'delim-token', chunk: '.', balance: 31 },
        { type: 'ident-token', chunk: 'test', balance: 31 },
        { type: 'whitespace-token', chunk: '\n', balance: 31 },
        { type: '{-token', chunk: '{', balance: 25 },
        { type: 'whitespace-token', chunk: '\n  ', balance: 25 },
        { type: 'ident-token', chunk: 'prop', balance: 25 },
        { type: 'colon-token', chunk: ':', balance: 25 },
        { type: 'whitespace-token', chunk: ' ', balance: 25 },
        { type: 'url-token', chunk: 'url(foo/bar.jpg)', balance: 25 },
        { type: 'whitespace-token', chunk: ' ', balance: 25 },
        { type: 'url-token', chunk: 'url( a\\(\\33 \\).\\ \\"\\\'test )', balance: 25 },
        { type: 'whitespace-token', chunk: ' ', balance: 25 },
        { type: 'function-token', chunk: 'calc(', balance: 18 },
        { type: 'number-token', chunk: '1', balance: 18 },
        { type: 'whitespace-token', chunk: ' ', balance: 18 },
        { type: 'delim-token', chunk: '+', balance: 18 },
        { type: 'whitespace-token', chunk: ' ', balance: 18 },
        { type: 'number-token', chunk: '1', balance: 18 },
        { type: ')-token', chunk: ')', balance: 12 },
        { type: 'whitespace-token', chunk: ' ', balance: 25 },
        { type: 'ident-token', chunk: '\\x', balance: 25 },
        { type: 'whitespace-token', chunk: ' ', balance: 25 },
        { type: 'ident-token', chunk: '\\aa ', balance: 25 },
        { type: 'semicolon-token', chunk: ';', balance: 25 },
        { type: 'whitespace-token', chunk: '\n', balance: 25 },
        { type: '}-token', chunk: '}', balance: 3 },
        { type: 'CDO-token', chunk: '<!--', balance: 31 },
        { type: 'delim-token', chunk: '<', balance: 31 },
        { type: 'CDC-token', chunk: '-->', balance: 31 },
        { type: 'delim-token', chunk: '\\', balance: 31 },
        { type: 'whitespace-token', chunk: '\n', balance: 31 }
    ];
    const dump = tokens.map(({ type, chunk, balance }, idx) => ({
        idx,
        type,
        chunk,
        balance
    }));
    const types = tokens.map(token => token.type);
    const start = tokens.map(function(token) {
        const start = this.offset;
        this.offset += token.chunk.length;
        return start;
    }, { offset: 0 });
    const end = tokens.map(function(token) {
        this.offset += token.chunk.length;
        return this.offset;
    }, { offset: 0 });

    it('edge case: no arguments', () => {
        const stream = createStream();

        assert.strictEqual(stream.eof, true);
        assert.strictEqual(stream.tokenType, 0);
        assert.strictEqual(stream.source, '');
    });

    it('edge case: empty input', () => {
        const stream = createStream('');

        assert.strictEqual(stream.eof, true);
        assert.strictEqual(stream.tokenType, 0);
        assert.strictEqual(stream.source, '');
    });

    it('should convert input to string', () => {
        const stream = createStream({
            toString() {
                return css;
            }
        });

        assert.strictEqual(stream.source, css);
    });

    it('should accept a Buffer', () => {
        const stream = createStream(Buffer.from(css));

        assert.strictEqual(stream.source, css);
    });

    it('dump()', () => {
        const stream = createStream(css);

        assert.deepStrictEqual(stream.dump(), dump);
    });

    it('next() types', () => {
        const stream = createStream(css);
        const actual = [];

        while (!stream.eof) {
            actual.push(tokenNames[stream.tokenType]);
            stream.next();
        }

        assert.deepStrictEqual(actual, types);
    });

    it('next() start', () => {
        const stream = createStream(css);
        const actual = [];

        while (!stream.eof) {
            actual.push(stream.tokenStart);
            stream.next();
        }

        assert.deepStrictEqual(actual, start);
    });

    it('next() end', () => {
        const stream = createStream(css);
        const actual = [];

        while (!stream.eof) {
            actual.push(stream.tokenEnd);
            stream.next();
        }

        assert.deepStrictEqual(actual, end);
    });

    it('skip()', () => {
        const stream = createStream(css);
        const targetTokens = tokens.filter(token =>
            token.type === 'ident-token' || token.type === 'delim-token'
        );
        const actual = targetTokens
            .map(function(token, idx, idents) {
                return idx ? tokens.indexOf(token) - tokens.indexOf(idents[idx - 1]) : tokens.indexOf(token);
            })
            .map(function(skip) {
                stream.skip(skip);
                return tokenNames[stream.tokenType];
            });

        assert.strictEqual(actual.length, 8); // 4 x Indentifier + 4 x delim-token
        assert.deepStrictEqual(actual, targetTokens.map(token => token.type));
    });

    it('skip() to end', () => {
        const stream = createStream(css);

        stream.skip(tokens.length);

        assert.strictEqual(stream.eof, true);
    });

    describe('Raw', () => {
        const LEFTCURLYBRACKET = 0x007B; // U+007B LEFT CURLY BRACKET ({)
        const SEMICOLON = 0x003B;        // U+003B SEMICOLON (;)
        const leftCurlyBracket = code => code === LEFTCURLYBRACKET ? 1 : 0;
        const semicolonIncluded = code => code === SEMICOLON ? 2 : 0;
        /* eslint-disable key-spacing */
        const tests = [
            {
                source: '? { }',
                start:  '^',
                skip:   '^',
                mode: leftCurlyBracket,
                expected: '? '
            },
            {
                // issues #56
                source: 'div { }',
                start:  '^',
                skip:   '^',
                mode: leftCurlyBracket,
                expected: 'div '
            },
            {
                source: 'foo(bar(1)(2)(3[{}])(4{}){}(5))',
                start:  '             ^',
                skip:   '             ^',
                mode: leftCurlyBracket,
                expected: '(3[{}])(4{})'
            },
            {
                source: 'foo(bar(1) (2) (3[{}]) (4{}) {} (5))',
                start:  '               ^',
                skip:   '                ^',
                mode: leftCurlyBracket,
                expected: '(3[{}]) (4{}) '
            },
            {
                source: 'func(a func(;))',
                start:  '     ^',
                skip:   '       ^',
                mode: semicolonIncluded,
                expected: 'a func(;)'
            },
            {
                source: 'func(a func(;))',
                start:  '     ^',
                skip:   '            ^',
                mode: semicolonIncluded,
                expected: 'a func(;)'
            },
            {
                source: 'func(a func(;); b)',
                start:  '     ^',
                skip:   '       ^',
                mode: semicolonIncluded,
                expected: 'a func(;);'
            },
            {
                source: 'func()',
                start:  '     ^',
                skip:   '     ^',
                mode: null,
                expected: ''
            },
            {
                source: 'func([{}])',
                start:  '      ^',
                skip:   '       ^',
                mode: null,
                expected: '{}'
            },
            {
                source: 'func([{})',
                start:  '     ^',
                skip:   '      ^',
                mode: null,
                expected: '[{})'
            },
            {
                source: 'func(1, 2, 3) {}',
                start:  '^',
                skip:   '      ^',
                mode: null,
                expected: 'func(1, 2, 3) {}'
            },
            {
                // the ")" mismatches the innermost "{" and is discarded;
                // the leading unclosed "(" makes the value swallow the stop token
                // until the end of input
                source: '([{); }',
                start:  '^',
                skip:   '^',
                mode: semicolonIncluded,
                expected: '([{); }'
            },
            {
                // a closing bracket not matching the innermost opener is discarded,
                // the unclosed "(" swallows everything up to the end of input
                source: '(.b{color:red;--y:);',
                start:  '^',
                skip:   '^',
                mode: semicolonIncluded,
                expected: '(.b{color:red;--y:);'
            },
            {
                // a matching closing bracket still terminates the block
                source: '(a);b',
                start:  '^',
                skip:   '^',
                mode: semicolonIncluded,
                expected: '(a);'
            }
        ];
        /* eslint-enable key-spacing */

        tests.forEach(function(test, idx) {
            it('testcase#' + idx, () => {
                const stream = createStream(test.source, tokenize);
                const startOffset = test.start.indexOf('^');
                const skipToOffset = test.skip.indexOf('^');
                let startToken = stream.tokenIndex;

                while (stream.tokenStart < startOffset) {
                    stream.next();
                    startToken = stream.tokenIndex;
                }

                while (stream.tokenStart < skipToOffset) {
                    stream.next();
                }

                stream.skipUntilBalanced(startToken, test.mode || (() => 0));
                assert.strictEqual(
                    stream.source.substring(startOffset, stream.tokenStart),
                    test.expected
                );
            });
        });
    });

    it('dynamic buffer', () => {
        const bufferSize = createStream(css, tokenize).offsetAndType.length + 10;
        const stream = createStream('.'.repeat(bufferSize), tokenize);
        let count = 0;

        while (!stream.eof) {
            count++;
            stream.next();
        }

        assert.strictEqual(count, bufferSize);
        assert(stream.offsetAndType.length >= bufferSize);
    });

    describe('balance', () => {
        it('top-level token balance points to the <EOF-token>', () => {
            const stream = createStream('a{b}c');
            const dump = stream.dump();

            assert.strictEqual(stream.tokenCount, 5);
            assert.strictEqual(stream.balance[stream.tokenCount], stream.tokenCount);
            assert.strictEqual(dump[0].balance, stream.tokenCount);
            assert.strictEqual(dump[4].balance, stream.tokenCount);
        });

        it('opening bracket balance points to the matching closing bracket token', () => {
            const stream = createStream('a([{x}])b');
            const dump = stream.dump();

            assert.strictEqual(dump[0].chunk, 'a(');
            assert.strictEqual(dump[0].balance, 6);
            assert.strictEqual(dump[1].balance, 5);
            assert.strictEqual(dump[2].balance, 4);
            assert.strictEqual(dump[4].balance, 2);
            assert.strictEqual(dump[5].balance, 1);
            assert.strictEqual(dump[6].balance, 0);
        });

        it('a mismatched closing bracket is discarded without popping the stack', () => {
            // ")" doesn't match the innermost opener "{" and is discarded;
            // "{" then matches the trailing "}", while "(" and "[" stay
            // unclosed up to the <EOF-token>
            const stream = createStream('([{); }');
            const dump = stream.dump();

            assert.strictEqual(dump[0].balance, stream.tokenCount);
            assert.strictEqual(dump[1].balance, stream.tokenCount);
            assert.strictEqual(dump[2].balance, 6);
            // the discarded ")" (and the rest until "}") belongs to the matched "{...}" block
            assert.strictEqual(dump[3].balance, 6);
            assert.strictEqual(dump[4].balance, 6);
            assert.strictEqual(dump[5].balance, 6);
            assert.strictEqual(dump[6].balance, 2);
        });

        it('an opener after a mismatched closing bracket still matches its own close', () => {
            const stream = createStream('(]b)');
            const dump = stream.dump();

            assert.strictEqual(dump[0].balance, 3);
            assert.strictEqual(dump[3].balance, 0);
            // the mismatched "]" is discarded but enclosed by the matched "(...)" pair
            assert.strictEqual(dump[1].balance, 3);
            assert.strictEqual(dump[2].balance, 3);
        });
    });

    describe('values', () => {
        ['valid', 'invalid'].forEach(testType => {
            fixture.forEachTest(testType, (name, value, expected) => {
                it(name, () => {
                    const actual = [];

                    tokenize(value, (type, start, end) => actual.push({
                        type: tokenNames[type],
                        chunk: value.substring(start, end)
                    }));

                    assert[testType === 'valid' ? 'deepEqual' : 'notDeepEqual'](
                        actual,
                        expected
                    );
                });
            });
        });
    });
});
