/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.example.com/prefix/velociraptor/app/index.html"}
 */

import {jest} from '@jest/globals';
import axios, {CancelToken} from 'axios';
import api from './api-service.jsx';

describe('API service compatibility with Axios', () => {
    let requests;
    let responses;
    let onSend;
    let errorHook;
    let savedGlobals;
    let savedAdapter;

    beforeEach(() => {
        savedGlobals = {
            base_path: window.base_path,
            globals: window.globals,
            CsrfToken: window.CsrfToken,
        };
        savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = 'xhr';
        window.base_path = '/prefix/velociraptor';
        window.globals = {OrgId: 'O123'};
        window.CsrfToken = 'csrf-before';
        requests = [];
        responses = [];
        onSend = () => {};
        errorHook = jest.fn();
        api.hooks.push(errorHook);

        // Stub only browser I/O: Axios still serializes requests, parses
        // responses, settles HTTP errors and runs axios-retry interceptors.
        jest.spyOn(window, 'XMLHttpRequest').mockImplementation(() => {
            const response = responses.shift() || {};
            const request = {
                onloadend: null,
                open: jest.fn(),
                setRequestHeader: jest.fn(),
                abort: jest.fn(),
                getAllResponseHeaders: () => response.headers || 'Content-Type: application/json\r\n',
                status: response.status || 200,
                statusText: '',
                responseText: response.body || '{"ok":true}',
                response: response.blob,
                send: jest.fn(() => {
                    onSend();
                    if (!request.abort.mock.calls.length) {
                        request.onloadend();
                    }
                }),
            };
            requests.push(request);
            return request;
        });
    });

    afterEach(() => {
        api.hooks.splice(api.hooks.indexOf(errorHook), 1);
        axios.defaults.adapter = savedAdapter;
        for (const [key, value] of Object.entries(savedGlobals)) {
            if (value === undefined) {
                delete window[key];
            } else {
                window[key] = value;
            }
        }
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test.each([
        ['get', 'GET'], ['post', 'POST'], ['delete_req', 'DELETE'],
    ])('%s sends org/CSRF headers, parses JSON and refreshes the CSRF token', async (method, verb) => {
        responses.push({headers: 'Content-Type: application/json\r\nX-CSRF-Token: csrf-after\r\n'});
        const response = await api[method]('v1/Test', {query: 'a & b'});
        const request = requests[0];
        const [actualVerb, url] = request.open.mock.calls[0];

        expect(actualVerb).toBe(verb);
        expect(new URL(url).origin).toBe('https://www.example.com');
        expect(new URL(url).pathname).toBe('/prefix/velociraptor/api/v1/Test');
        expect(request.setRequestHeader).toHaveBeenCalledWith('Grpc-Metadata-OrgId', 'O123');
        expect(request.setRequestHeader).toHaveBeenCalledWith('X-CSRF-Token', 'csrf-before');
        if (verb === 'POST') {
            expect(JSON.parse(request.send.mock.calls[0][0])).toEqual({query: 'a & b'});
            expect(request.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
        } else {
            expect(new URL(url).searchParams.get('query')).toBe('a & b');
        }
        expect(response.data).toEqual({ok: true});
        expect(window.CsrfToken).toBe('csrf-after');
    });

    test.each(['', '{{.OrgId}}'])('uses the root org for the unset value %s', async orgId => {
        window.globals.OrgId = orgId;
        window.CsrfToken = '{{.CsrfToken}}';
        await api.get('v1/Test');

        expect(requests[0].setRequestHeader).toHaveBeenCalledWith('Grpc-Metadata-OrgId', 'root');
        expect(requests[0].setRequestHeader.mock.calls.map(([name]) => name)).not.toContain('X-CSRF-Token');
    });

    test.each(['Content-Type: application/json\r\n', 'X-CSRF-Token: \r\n'])(
        'keeps the existing CSRF token when the response has no replacement (%s)', async headers => {
            responses.push({headers});
            await api.get('v1/Test');
            expect(window.CsrfToken).toBe('csrf-before');
        });

    test('uploads files and JSON parameters as browser FormData', async () => {
        const file = new File(['contents'], 'evidence.txt', {type: 'text/plain'});
        await api.upload('v1/Upload', {file}, {client_id: 'C.123'});
        const body = requests[0].send.mock.calls[0][0];

        expect(body).toBeInstanceOf(FormData);
        expect(body.get('file')).toBe(file);
        expect(JSON.parse(body.get('_params_'))).toEqual({client_id: 'C.123'});
        // The browser must supply the multipart boundary.
        expect(requests[0].setRequestHeader.mock.calls.map(([name]) => name.toLowerCase())).not.toContain('content-type');
    });

    test('downloads a blob with repeated query parameters and intact bytes', async () => {
        responses.push({blob: new Blob(['evidence'])});
        const result = await api.get_blob('v1/Download', {fs_components: ['clients', 'a & b']});
        const url = new URL(requests[0].open.mock.calls[0][1]);

        expect(url.searchParams.getAll('fs_components')).toEqual(['clients', 'a & b']);
        expect([...url.searchParams.keys()]).toEqual(['fs_components', 'fs_components']);
        expect(requests[0].responseType).toBe('blob');
        expect(Array.from(new Uint8Array(result.data))).toEqual([101, 118, 105, 100, 101, 110, 99, 101]);
    });

    test.each(['get', 'post', 'delete_req'])(
        '%s handles an already cancelled token without sending a request', async method => {
            const source = CancelToken.source();
            source.cancel('component unmounted');

            await expect(api[method]('v1/Test', {}, source.token)).resolves.toEqual({data: {}, cancel: true});
            expect(requests).toHaveLength(0);
            expect(errorHook).not.toHaveBeenCalled();
        });

    test('aborts an in-flight request when its CancelToken is cancelled', async () => {
        const source = CancelToken.source();
        onSend = () => source.cancel('component unmounted');
        // Cancellation is delivered asynchronously; leave the response pending.
        responses.push({});
        const originalMock = window.XMLHttpRequest.getMockImplementation();
        window.XMLHttpRequest.mockImplementation(() => {
            const request = originalMock();
            request.send.mockImplementation(onSend);
            return request;
        });

        await expect(api.get('v1/Test', {}, source.token)).resolves.toEqual({data: {}, cancel: true});
        expect(requests[0].abort).toHaveBeenCalledTimes(1);
        expect(requests).toHaveLength(1);
        expect(errorHook).not.toHaveBeenCalled();
    });

    test.each([
        ['get', 400, {message: 'invalid input'}],
        ['get', 503, {code: 2, message: 'application error'}],
        ['post', 503, {message: 'unavailable'}],
    ])('%s rejects HTTP %s without an unsafe retry', async (method, status, body) => {
        responses.push({status, body: JSON.stringify(body)});
        await expect(api[method]('v1/Test', {})).rejects.toMatchObject({response: {status}});
        expect(requests).toHaveLength(1);
        expect(errorHook).toHaveBeenCalledTimes(1);
        expect(errorHook).toHaveBeenCalledWith('Error: ' + body.message);
    });

    test('retries a transient GET failure through axios-retry', async () => {
        jest.useFakeTimers();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        responses.push({status: 503, body: '{}'}, {body: '{"recovered":true}'});
        const result = api.get('v1/Test');
        await jest.runAllTimersAsync();

        await expect(result).resolves.toMatchObject({data: {recovered: true}});
        expect(requests).toHaveLength(2);
        expect(requests[1].open.mock.calls).toEqual(requests[0].open.mock.calls);
        expect(errorHook).not.toHaveBeenCalled();
    });

    test('stops after three retries and reports the final failure once', async () => {
        jest.useFakeTimers();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        responses.push(...Array.from({length: 4}, () => ({status: 503, body: '{"message":"unavailable"}'})));
        const assertion = expect(api.get('v1/Test')).rejects.toMatchObject({response: {status: 503}});
        await jest.runAllTimersAsync();
        await assertion;

        expect(requests).toHaveLength(4);
        expect(errorHook).toHaveBeenCalledTimes(1);
        expect(errorHook).toHaveBeenCalledWith('Error: unavailable');
    });
});
