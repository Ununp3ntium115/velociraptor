import {jest} from '@jest/globals';
import React from 'react';
import parseHTML, {sanitize} from './sanitize.jsx';

describe('DOMPurify compatibility with report and notebook HTML', () => {
    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test.each(['', 'plain text', '<p>Hello <strong>world</strong></p>'])(
        'preserves safe content: %s', html => {
            expect(sanitize(html)).toBe(html);
        });

    test.each([
        'notebook-cell', 'grr-value', 'bar-chart-view', 'scatter-chart-view',
        'time-chart-view', 'tool-viewer-panel', 'velo-value',
    ])('preserves the supported custom element %s and its data', tag => {
        const html = `<${tag} value="42" params="{}" base-url="/api/v1">content</${tag}>`;
        expect(sanitize(html)).toBe(html);
    });

    test('removes unsupported custom tags while retaining their safe content', () => {
        expect(sanitize('<unknown-widget><b>keep</b></unknown-widget>')).toBe('<b>keep</b>');
    });

    test('preserves customized built-in elements used by report widgets', () => {
        expect(sanitize('<div is="velo-value">42</div>')).toBe(
            '<div is="velo-value">42</div>');
    });

    test.each([
        ['script', '<p>keep</p><script>alert(1)</script>', '<p>keep</p>'],
        ['event handler', '<img src="/image.png" onerror="alert(1)">', '<img src="/image.png">'],
        ['custom element event handler', '<velo-value value="42" onclick="alert(1)"></velo-value>', '<velo-value value="42"></velo-value>'],
        ['script URL', '<a href="javascript:alert(1)">keep</a>', '<a>keep</a>'],
        ['encoded script URL', '<a href="java&#x09;script:alert(1)">keep</a>', '<a>keep</a>'],
        ['HTML data URL', '<a href="data:text/html,<script>alert(1)</script>">keep</a>', '<a>keep</a>'],
        ['iframe', '<iframe src="https://example.com"></iframe><p>keep</p>', '<p>keep</p>'],
    ])('removes %s without losing safe content', (name, html, expected) => {
        expect(sanitize(html)).toBe(expected);
    });

    test.each(['/downloads/report.html', 'https://example.com/report', '#section'])(
        'preserves the safe link %s', href => {
            expect(sanitize(`<a href="${href}">report</a>`)).toBe(
                `<a href="${href}">report</a>`);
        });

    // DOMPurify 3.4.0 expands the raw-text closing tags rejected in attribute
    // values. These can change parsing context when report HTML is reinserted.
    test.each(['script', 'xmp', 'noscript', 'iframe', 'noembed', 'noframes'])(
        'rejects a closing %s tag embedded in widget data', tag => {
            expect(sanitize(`<velo-value value="</${tag}><img src=x onerror=alert(1)>">safe</velo-value>`)).toBe(
                '<velo-value>safe</velo-value>');
        });

    test('sanitizes before passing nodes to the React parser replacement callback', () => {
        const replace = jest.fn(node => {
            if (node.name === 'velo-value') {
                return React.createElement('span', null, node.attribs.value);
            }
        });

        const result = parseHTML(
            '<velo-value value="42" onclick="alert(1)"></velo-value>', {replace});

        expect(replace).toHaveBeenCalledWith(expect.objectContaining({
            name: 'velo-value',
            attribs: {value: '42'},
        }));
        expect(React.isValidElement(result)).toBe(true);
        expect(result.type).toBe('span');
        expect(result.props.children).toBe('42');
    });

    test('parses safe markup without replacement options', () => {
        const result = parseHTML('<p onclick="alert(1)">safe</p>');
        expect(result.type).toBe('p');
        expect(result.props).toEqual({children: 'safe'});
    });
});
