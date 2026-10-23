// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/buffer.js
var bufferToFormData = (arrayBuffer, contentType) => {
  return new Response(arrayBuffer, { headers: { "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase()) } }).formData();
};

// node_modules/hono/dist/utils/body.js
var MAX_NESTED_OBJECTS = 1e4;
var isRawRequest = (request) => "headers" in request;
var parseBody = async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const mediaType = (isRawRequest(request) ? request.headers : request.raw.headers).get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") return parseFormData(request, {
    all,
    dot
  });
  return {};
};
async function parseFormData(request, options) {
  if (!isRawRequest(request) && request.bodyCache.formData) return convertFormDataToBodyData(await request.bodyCache.formData, options);
  const headers = isRawRequest(request) ? request.headers : request.raw.headers;
  const arrayBuffer = await request.arrayBuffer();
  const formDataPromise = bufferToFormData(arrayBuffer, headers.get("Content-Type") || "");
  if (!isRawRequest(request)) request.bodyCache.formData = formDataPromise;
  const formData = await formDataPromise;
  if (formData) return convertFormDataToBodyData(formData, options);
  return {};
}
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  const nestingState = { count: 0 };
  formData.forEach((value, key) => {
    if (!(options.all || key.endsWith("[]"))) form[key] = value;
    else handleParsingAllValues(form, key, value);
  });
  if (options.dot) Object.entries(form).forEach(([key, value]) => {
    if (key.includes(".")) {
      handleParsingNestedValues(form, key, value, nestingState);
      delete form[key];
    }
  });
  return form;
}
var handleParsingAllValues = (form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) form[key].push(value);
    else form[key] = [form[key], value];
  } else if (!key.endsWith("[]")) form[key] = value;
  else form[key] = [value];
};
var handleParsingNestedValues = (form, key, value, state) => {
  if (/(?:^|\.)__proto__\./.test(key)) return;
  let nestedForm = form;
  const keys = key.split(".", 34);
  if (keys.length > 33) throwNestingLimitExceeded();
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) nestedForm[key2] = value;
    else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        if (state.count++ >= MAX_NESTED_OBJECTS) throwNestingLimitExceeded();
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
};
var throwNestingLimitExceeded = () => {
  throw new Error("Nesting limit exceeded");
};

// node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
  const paths = path.split("/");
  if (paths[0] === "") paths.shift();
  return paths;
};
var splitRoutingPath = (routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
};
var extractGroupsFromPath = (path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return {
    groups,
    path
  };
};
var replaceGroupMarks = (paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) if (paths[j].includes(mark)) {
      paths[j] = paths[j].replace(mark, groups[i][1]);
      break;
    }
  }
  return paths;
};
var patternCache = {};
var getPattern = (label, next) => {
  if (label === "*") return "*";
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [
        cacheKey,
        match2[1],
        new RegExp(`^${match2[2]}(?=/${next})`)
      ] : [
        label,
        match2[1],
        new RegExp(`^${match2[2]}$`)
      ];
      else patternCache[cacheKey] = [
        label,
        match2[1],
        true
      ];
    }
    return patternCache[cacheKey];
  }
  return null;
};
var tryDecode = (str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
};
var tryDecodeURI = (str) => tryDecode(str, decodeURI);
var getPath = (request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) break;
  }
  return url.slice(start, i);
};
var getPathNoStrict = (request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
var mergePath = (base, sub, ...rest) => {
  if (rest.length) sub = mergePath(sub, ...rest);
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
var checkOptionalParameter = (path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) return null;
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) basePath += "/" + segment;
    else if (/\:/.test(segment)) {
      if (segment.charCodeAt(segment.length - 1) === 63) {
        if (results.length === 0 && basePath === "") results.push("/");
        else results.push(basePath);
        const optionalSegment = segment.slice(0, -1);
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else basePath += "/" + segment;
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
};
var tryDecodeURIComponent = (str) => str.indexOf("%") !== -1 ? tryDecode(str, decodeURIComponent_) : str;
var _decodeURI = (value) => {
  if (value.indexOf("+") !== -1) value = value.replace(/\+/g, " ");
  return tryDecodeURIComponent(value);
};
var _getQueryParam = (url, key, multiple) => {
  const hashIndex = url.indexOf("#", 8);
  if (hashIndex !== -1) url = url.slice(0, hashIndex);
  let encoded;
  if (!multiple && key && key.indexOf("%") === -1 && key.indexOf("+") === -1) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) return;
    if (!url.startsWith(key, keyIndex2 + 1)) keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) return "";
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) return;
  }
  const results = /* @__PURE__ */ Object.create(null);
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) valueIndex = -1;
    let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex);
    if (encoded) name = _decodeURI(name);
    keyIndex = nextKeyIndex;
    if (name === "") continue;
    let value;
    if (valueIndex === -1) value = "";
    else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) value = _decodeURI(value);
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) results[name] = [];
      results[name].push(value);
    } else results[name] ??= value;
  }
  return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
  return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var HonoRequest = class {
  /**
  * `.raw` can get the raw Request object.
  *
  * @see {@link https://hono.dev/docs/api/request#raw}
  *
  * @example
  * ```ts
  * // For Cloudflare Workers
  * app.post('/', async (c) => {
  *   const metadata = c.req.raw.cf?.hostMetadata?
  *   ...
  * })
  * ```
  */
  raw;
  #validatedData;
  #matchResult;
  routeIndex = 0;
  /**
  * `.path` can get the pathname of the request.
  *
  * @see {@link https://hono.dev/docs/api/request#path}
  *
  * @example
  * ```ts
  * app.get('/about/me', (c) => {
  *   const pathname = c.req.path // `/about/me`
  * })
  * ```
  */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex]?.[1][key];
    const param = this.#getParamValue(paramKey);
    return param && tryDecodeURIComponent(param);
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex]?.[1] ?? {});
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) decoded[key] = tryDecodeURIComponent(value);
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) return this.raw.headers.get(name) ?? void 0;
    const headerData = /* @__PURE__ */ Object.create(null);
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = (key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) return cachedBody;
    for (const anyCachedKey in bodyCache) return bodyCache[anyCachedKey].then((body) => {
      if (anyCachedKey === "json") body = JSON.stringify(body);
      const contentType = anyCachedKey === "formData" ? void 0 : raw2.headers.get("content-type");
      return new Response(body, { headers: contentType ? { "Content-Type": contentType } : void 0 })[key]();
    });
    return bodyCache[key] = raw2[key]();
  };
  /**
  * `.json()` can parse Request body of type `application/json`
  *
  * @see {@link https://hono.dev/docs/api/request#json}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.json()
  * })
  * ```
  */
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  /**
  * `.text()` can parse Request body of type `text/plain`
  *
  * @see {@link https://hono.dev/docs/api/request#text}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.text()
  * })
  * ```
  */
  text() {
    return this.#cachedBody("text");
  }
  /**
  * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
  *
  * @see {@link https://hono.dev/docs/api/request#arraybuffer}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.arrayBuffer()
  * })
  * ```
  */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
  * `.bytes()` parses the request body as a `Uint8Array`.
  *
  * @see {@link https://hono.dev/docs/api/request#bytes}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.bytes()
  * })
  * ```
  */
  bytes() {
    return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
  }
  /**
  * Parses the request body as a `Blob`.
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.blob();
  * });
  * ```
  * @see https://hono.dev/docs/api/request#blob
  */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
  * Parses the request body as `FormData`.
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.formData();
  * });
  * ```
  * @see https://hono.dev/docs/api/request#formdata
  */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
  * Adds validated data to the request.
  *
  * @param target - The target of the validation.
  * @param data - The validated data to add.
  */
  addValidatedData(target, data) {
    (this.#validatedData ??= {})[target] = data;
  }
  valid(target) {
    return this.#validatedData?.[target];
  }
  /**
  * `.url` can get the request url strings.
  *
  * @see {@link https://hono.dev/docs/api/request#url}
  *
  * @example
  * ```ts
  * app.get('/about/me', (c) => {
  *   const url = c.req.url // `http://localhost:8787/about/me`
  *   ...
  * })
  * ```
  */
  get url() {
    return this.raw.url;
  }
  /**
  * `.method` can get the method name of the request.
  *
  * @see {@link https://hono.dev/docs/api/request#method}
  *
  * @example
  * ```ts
  * app.get('/about/me', (c) => {
  *   const method = c.req.method // `GET`
  * })
  * ```
  */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
  * `.matchedRoutes` can return a matched route in the handler
  *
  * @deprecated
  *
  * Use matchedRoutes helper defined in "hono/route" instead.
  *
  * @see {@link https://hono.dev/docs/api/request#matchedroutes}
  *
  * @example
  * ```ts
  * app.use('*', async function logger(c, next) {
  *   await next()
  *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
  *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
  *     console.log(
  *       method,
  *       ' ',
  *       path,
  *       ' '.repeat(Math.max(10 - path.length, 0)),
  *       name,
  *       i === c.req.routeIndex ? '<- respond from here' : ''
  *     )
  *   })
  * })
  * ```
  */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
  * `.routePath` can retrieve the path registered within the handler
  *
  * @deprecated
  *
  * Use routePath helper defined in "hono/route" instead.
  *
  * @see {@link https://hono.dev/docs/api/request#routepath}
  *
  * @example
  * ```ts
  * app.get('/posts/:id', (c) => {
  *   return c.json({ path: c.req.routePath })
  * })
  * ```
  */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = (value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) str = str.toString();
    if (str instanceof Promise) str = await str;
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) return Promise.resolve(str);
  if (buffer) buffer[0] += str;
  else buffer = [str];
  const resStr = Promise.all(callbacks.map((c) => c({
    phase,
    buffer,
    context
  }))).then((res) => Promise.all(res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))).then(() => buffer[0]));
  if (preserveCallbacks) return raw(await resStr, callbacks);
  else return resStr;
};

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = (contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
};
var createResponseInstance = (body, init) => new Response(body, init);
var Context = class {
  #rawRequest;
  #req;
  /**
  * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
  *
  * @see {@link https://hono.dev/docs/api/context#env}
  *
  * @example
  * ```ts
  * // Environment object for Cloudflare Workers
  * app.get('*', async c => {
  *   const counter = c.env.COUNTER
  * })
  * ```
  */
  env = {};
  #var;
  finalized = false;
  /**
  * `.error` can get the error object from the middleware if the Handler throws an error.
  *
  * @see {@link https://hono.dev/docs/api/context#error}
  *
  * @example
  * ```ts
  * app.use('*', async (c, next) => {
  *   await next()
  *   if (c.error) {
  *     // do something...
  *   }
  * })
  * ```
  */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
  * Creates an instance of the Context class.
  *
  * @param req - The Request object.
  * @param options - Optional configuration options for the context.
  */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
  * `.req` is the instance of {@link HonoRequest}.
  */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
  * @see {@link https://hono.dev/docs/api/context#event}
  * The FetchEvent associated with the current request.
  *
  * @throws Will throw an error if the context does not have a FetchEvent.
  */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) return this.#executionCtx;
    else throw Error("This context has no FetchEvent");
  }
  /**
  * @see {@link https://hono.dev/docs/api/context#executionctx}
  * The ExecutionContext associated with the current request.
  *
  * @throws Will throw an error if the context does not have an ExecutionContext.
  */
  get executionCtx() {
    if (this.#executionCtx) return this.#executionCtx;
    else throw Error("This context has no ExecutionContext");
  }
  /**
  * @see {@link https://hono.dev/docs/api/context#res}
  * The Response object for the current request.
  */
  get res() {
    return this.#res ||= createResponseInstance(null, { headers: this.#preparedHeaders ??= new Headers() });
  }
  /**
  * Sets the Response object for the current request.
  *
  * @param _res - The Response object to set.
  */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") continue;
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) _res.headers.append("set-cookie", cookie);
        } else _res.headers.set(k, v);
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
  * `.render()` can create a response within a layout.
  *
  * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
  *
  * @example
  * ```ts
  * app.get('/', (c) => {
  *   return c.render('Hello!')
  * })
  * ```
  */
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  /**
  * Sets the layout for the response.
  *
  * @param layout - The layout to set.
  * @returns The layout function.
  */
  setLayout = (layout) => this.#layout = layout;
  /**
  * Gets the current layout for the response.
  *
  * @returns The current layout function.
  */
  getLayout = () => this.#layout;
  /**
  * `.setRenderer()` can set the layout in the custom middleware.
  *
  * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
  *
  * @example
  * ```tsx
  * app.use('*', async (c, next) => {
  *   c.setRenderer((content) => {
  *     return c.html(
  *       <html>
  *         <body>
  *           <p>{content}</p>
  *         </body>
  *       </html>
  *     )
  *   })
  *   await next()
  * })
  * ```
  */
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  /**
  * `.header()` can set headers.
  *
  * @see {@link https://hono.dev/docs/api/context#header}
  *
  * @example
  * ```ts
  * app.get('/welcome', (c) => {
  *   // Set headers
  *   c.header('X-Message', 'Hello!')
  *   c.header('Content-Type', 'text/plain')
  *
  *   // Append multiple headers using the append option (e.g. Vary)
  *   c.header('Vary', 'Accept-Encoding', { append: true })
  *   c.header('Vary', 'User-Agent', { append: true })
  *
  *   return c.body('Thank you for coming')
  * })
  * ```
  */
  header = (name, value, options) => {
    if (this.finalized) this.#res = createResponseInstance(this.#res.body, this.#res);
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) headers.delete(name);
    else if (options?.append) headers.append(name, value);
    else headers.set(name, value);
  };
  status = (status) => {
    this.#status = status;
  };
  /**
  * `.set()` can set the value specified by the key.
  *
  * @see {@link https://hono.dev/docs/api/context#set-get}
  *
  * @example
  * ```ts
  * app.use('*', async (c, next) => {
  *   c.set('message', 'Hono is hot!!')
  *   await next()
  * })
  * ```
  */
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  };
  /**
  * `.get()` can use the value specified by the key.
  *
  * @see {@link https://hono.dev/docs/api/context#set-get}
  *
  * @example
  * ```ts
  * app.get('/', (c) => {
  *   const message = c.get('message')
  *   return c.text(`The message is "${message}"`)
  * })
  * ```
  */
  get = (key) => {
    return this.#var ? this.#var.get(key) : void 0;
  };
  /**
  * `.var` can access the value of a variable.
  *
  * @see {@link https://hono.dev/docs/api/context#var}
  *
  * @example
  * ```ts
  * const result = c.var.client.oneMethod()
  * ```
  */
  get var() {
    if (!this.#var) return {};
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    let responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders;
    if (typeof arg === "object" && arg.headers) {
      responseHeaders ??= new Headers();
      for (const [key, value] of new Headers(arg.headers)) if (key === "set-cookie") responseHeaders.append(key, value);
      else responseHeaders.set(key, value);
    }
    if (headers) {
      if (!responseHeaders) {
        let count = 0;
        for (const k in headers) if (++count > 1 || typeof headers[k] !== "string") {
          responseHeaders = new Headers();
          break;
        }
      }
      if (responseHeaders) for (const k in headers) {
        const v = headers[k];
        if (typeof v === "string") responseHeaders.set(k, v);
        else {
          responseHeaders.delete(k);
          for (const v2 of v) responseHeaders.append(k, v2);
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, {
      status,
      headers: responseHeaders ?? headers
    });
  }
  newResponse = (...args) => this.#newResponse(...args);
  /**
  * `.body()` can return the HTTP response.
  * You can set headers with `.header()` and set HTTP status code with `.status`.
  * This can also be set in `.text()`, `.json()` and so on.
  *
  * @see {@link https://hono.dev/docs/api/context#body}
  *
  * @example
  * ```ts
  * app.get('/welcome', (c) => {
  *   // Set headers
  *   c.header('X-Message', 'Hello!')
  *   c.header('Content-Type', 'text/plain')
  *   // Set HTTP status code
  *   c.status(201)
  *
  *   // Return the response body
  *   return c.body('Thank you for coming')
  * })
  * ```
  */
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  /**
  * `.text()` can render text as `Content-Type:text/plain`.
  *
  * @see {@link https://hono.dev/docs/api/context#text}
  *
  * @example
  * ```ts
  * app.get('/say', (c) => {
  *   return c.text('Hello!')
  * })
  * ```
  */
  text = (text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
  };
  /**
  * `.json()` can render JSON as `Content-Type:application/json`.
  *
  * @see {@link https://hono.dev/docs/api/context#json}
  *
  * @example
  * ```ts
  * app.get('/api', (c) => {
  *   return c.json({ message: 'Hello!' })
  * })
  * ```
  */
  json = (object, arg, headers) => {
    return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType("application/json", headers));
  };
  html = (html, arg, headers) => {
    const res = (html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  /**
  * `.redirect()` can Redirect, default status code is 302.
  *
  * @see {@link https://hono.dev/docs/api/context#redirect}
  *
  * @example
  * ```ts
  * app.get('/redirect', (c) => {
  *   return c.redirect('/')
  * })
  * app.get('/redirect-permanently', (c) => {
  *   return c.redirect('/', 301)
  * })
  * ```
  */
  redirect = (location, status) => {
    const locationString = String(location);
    this.header("Location", !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
    return this.newResponse(null, status ?? 302);
  };
  /**
  * `.notFound()` can return the Not Found Response.
  *
  * @see {@link https://hono.dev/docs/api/context#notfound}
  *
  * @example
  * ```ts
  * app.get('/notfound', (c) => {
  *   return c.notFound()
  * })
  * ```
  */
  notFound = () => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  };
};

// node_modules/hono/dist/compose.js
var compose = (middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else handler = i === middleware.length && next || void 0;
      if (handler) try {
        res = await handler(context, () => dispatch(i + 1));
      } catch (err) {
        if (err instanceof Error && onError) {
          context.error = err;
          res = await onError(err, context);
          isError = true;
        } else throw err;
      }
      else if (context.finalized === false && onNotFound) res = await onNotFound(context);
      if (res && (context.finalized === false || isError)) context.res = res;
      return context;
    }
  };
};

// node_modules/hono/dist/router.js
var METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "options",
  "patch",
  "query"
];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
};

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/hono-base.js
var notFoundHandler = (c) => {
  return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
};
var Hono = class Hono2 {
  get;
  post;
  put;
  delete;
  options;
  patch;
  query;
  all;
  on;
  use;
  router;
  getPath;
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    [...METHODS, "all"].forEach((method) => {
      this[method] = (args1, ...args) => {
        const methodName = method.toUpperCase();
        if (typeof args1 === "string") this.#path = args1;
        else this.#addRoute(methodName, this.#path, args1);
        args.forEach((handler) => {
          this.#addRoute(methodName, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          const methodName = m.toUpperCase();
          for (const handler of handlers) this.#addRoute(methodName, this.#path, handler);
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") this.#path = arg1;
      else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute("ALL", this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new Hono2({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  errorHandler = errorHandler;
  /**
  * `.route()` allows grouping other Hono instance in routes.
  *
  * @see {@link https://hono.dev/docs/api/routing#grouping}
  *
  * @param {string} path - base Path
  * @param {Hono} app - other Hono instance
  * @returns {Hono} routed Hono instance
  *
  * @example
  * ```ts
  * const app = new Hono()
  * const app2 = new Hono()
  *
  * app2.get("/user", (c) => c.text("user"))
  * app.route("/api", app2) // GET /api/user
  * ```
  */
  route(path, app2) {
    const subApp = this.basePath(path);
    app2.routes.map((r) => {
      let handler;
      if (app2.errorHandler === errorHandler) handler = r.handler;
      else {
        handler = async (c, next) => (await compose([], app2.errorHandler)(c, () => r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
  * `.basePath()` allows base paths to be specified.
  *
  * @see {@link https://hono.dev/docs/api/routing#base-path}
  *
  * @param {string} path - base Path
  * @returns {Hono} changed Hono instance
  *
  * @example
  * ```ts
  * const api = new Hono().basePath('/api')
  * ```
  */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
  * `.onError()` handles an error and returns a customized Response.
  *
  * @see {@link https://hono.dev/docs/api/hono#error-handling}
  *
  * @param {ErrorHandler} handler - request Handler for error
  * @returns {Hono} changed Hono instance
  *
  * @example
  * ```ts
  * app.onError((err, c) => {
  *   console.error(`${err}`)
  *   return c.text('Custom Error Message', 500)
  * })
  * ```
  */
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  /**
  * `.notFound()` allows you to customize a Not Found Response.
  *
  * @see {@link https://hono.dev/docs/api/hono#not-found}
  *
  * @param {NotFoundHandler} handler - request handler for not-found
  * @returns {Hono} changed Hono instance
  *
  * @example
  * ```ts
  * app.notFound((c) => {
  *   return c.text('Custom 404 Message', 404)
  * })
  * ```
  */
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  /**
  * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
  *
  * @deprecated Use `mount()` from `hono/mount` instead. `.mount()` will be removed in v5.
  *
  * @see {@link https://hono.dev/docs/api/hono#mount}
  *
  * @param {string} path - base Path
  * @param {Function} applicationHandler - other Request Handler
  * @param {MountOptions} [options] - options of `.mount()`
  * @returns {Hono} mounted Hono instance
  *
  * @example
  * ```ts
  * import { Router as IttyRouter } from 'itty-router'
  * import { Hono } from 'hono'
  * // Create itty-router application
  * const ittyRouter = IttyRouter()
  * // GET /itty-router/hello
  * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
  *
  * const app = new Hono()
  * app.mount('/itty-router', ittyRouter.handle)
  * ```
  *
  * @example
  * ```ts
  * const app = new Hono()
  * // Send the request to another application without modification.
  * app.mount('/app', anotherApp, {
  *   replaceRequest: (req) => req,
  * })
  * ```
  */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") optionHandler = options;
      else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) replaceRequest = (request) => request;
        else replaceRequest = options.replaceRequest;
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = this.getPath(request).slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) return res;
      await next();
    };
    this.#addRoute("ALL", mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) return this.errorHandler(err, c);
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
  * `.fetch()` will be entry point of your app.
  *
  * @see {@link https://hono.dev/docs/api/hono#fetch}
  *
  * @param {Request} request - request Object of request
  * @param {Env} env - env Object
  * @param {ExecutionContext} executionCtx - context of execution
  * @returns {Response | Promise<Response>} response of request
  *
  */
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  /**
  * `.request()` is a useful method for testing.
  * You can pass a URL or pathname to send a GET request.
  * app will return a Response object.
  * ```ts
  * test('GET /hello is ok', async () => {
  *   const res = await app.request('/hello')
  *   expect(res.status).toBe(200)
  * })
  * ```
  * @see https://hono.dev/docs/api/hono#request
  */
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    input = input.toString();
    return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
  };
  /**
  * `.fire()` automatically adds a global fetch event listener.
  * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
  * @deprecated
  * Use `fire` from `hono/service-worker` instead.
  * ```ts
  * import { Hono } from 'hono'
  * import { fire } from 'hono/service-worker'
  *
  * const app = new Hono()
  * // ...
  * fire(app)
  * ```
  * @see https://hono.dev/docs/api/hono#fire
  * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
  * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
  */
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  };
};

// node_modules/hono/dist/router/utils.js
var createNullObject = () => /* @__PURE__ */ Object.create(null);

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = ((method2, path2) => {
    const matcher = matchers[method2] || matchers["ALL"];
    const staticMatch = matcher[2][path2];
    if (staticMatch) return staticMatch;
    const match3 = path2.match(matcher[0]);
    if (!match3) return [[], emptyParam];
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  });
  this.match = match2;
  return match2(method, path);
}

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = /* @__PURE__ */ new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) return b.length === 1 ? a < b ? -1 : 1 : -1;
  if (b.length === 1) return 1;
  if (a === ".*" || a === "(?:|/.*)") return b === "(?:|/.*)" ? -1 : 1;
  else if (b === ".*" || b === "(?:|/.*)") return -1;
  if (a === "[^/]+") return 1;
  else if (b === "[^/]+") return -1;
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node = class Node2 {
  #index;
  #varIndex;
  #children = createNullObject();
  insert(tokens, index, paramMap, context, isStatic) {
    let node = this;
    for (let i = 0, len = tokens.length; i < len; i++) {
      const token = tokens[i];
      const pattern = token.length === 1 ? token === "*" ? i === len - 1 ? [
        "",
        "",
        ".*"
      ] : [
        "",
        "",
        LABEL_REG_EXP_STR
      ] : null : token === "/*" ? [
        "",
        "",
        TAIL_WILDCARD_REG_EXP_STR
      ] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
      let nextNode;
      if (pattern) {
        const name = pattern[1];
        let regexpStr = pattern[2] || "[^/]+";
        if (name && pattern[2]) {
          if (regexpStr === ".*") throw PATH_ERROR;
          regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
          if (/\((?!\?:)/.test(regexpStr)) throw PATH_ERROR;
          if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) throw PATH_ERROR;
        }
        nextNode = node.#children[regexpStr];
        if (!nextNode) {
          if (regexpStr !== ".*" && regexpStr !== "(?:|/.*)") {
            for (const k in node.#children) if ((regexpStr.length > 1 || k.length > 1) && k !== ".*" && k !== "(?:|/.*)") throw PATH_ERROR;
          }
          nextNode = node.#children[regexpStr] = new Node2();
        }
        if (name !== "") {
          nextNode.#varIndex ??= context.varIndex++;
          paramMap.push([name, nextNode.#varIndex]);
        }
      } else {
        nextNode = node.#children[token];
        if (!nextNode) {
          for (const k in node.#children) if (k.length > 1 && k !== ".*" && k !== "(?:|/.*)") throw PATH_ERROR;
          nextNode = node.#children[token] = new Node2();
        }
      }
      node = nextNode;
    }
    if (node.#index !== void 0) throw PATH_ERROR;
    node.#index = isStatic ? -1 : index;
  }
  buildRegExpStr() {
    const strList = Object.keys(this.#children).sort(compareKey).map((k) => {
      const c = this.#children[k];
      const childStr = c.buildRegExpStr();
      return childStr === "" ? "" : (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + childStr;
    }).filter(Boolean);
    if (typeof this.#index === "number" && this.#index !== -1) strList.unshift(`#${this.#index}`);
    if (strList.length === 0) return "";
    if (strList.length === 1) return strList[0];
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  #context = { varIndex: 0 };
  #root = new Node();
  #index = 0;
  paths = createNullObject();
  insert(path, isStatic) {
    if (isStatic) {
      this.#root.insert(path.split(""), 0, [], this.#context, true);
      return;
    }
    const paramAssoc = [];
    const groups = [];
    let markedPath = path;
    for (let i = 0; ; ) {
      let replaced = false;
      markedPath = markedPath.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) break;
    }
    const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) if (tokens[j].indexOf(mark) !== -1) {
        tokens[j] = tokens[j].replace(mark, groups[i][1]);
        break;
      }
    }
    this.#root.insert(tokens, this.#index, paramAssoc, this.#context, false);
    this.paths[path] = [this.#index++, paramAssoc];
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") return [
      /^$/,
      [],
      []
    ];
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [
      new RegExp(`^${regexp}`),
      indexReplacementMap,
      paramReplacementMap
    ];
  }
};

// node_modules/hono/dist/router/reg-exp-router/router.js
var wildcardRegExpCache = createNullObject();
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(`^${path.replace(/\/:[^/{}]+(?:\{\[\^\/]\+})?(?=[/{]|$)|\/?\*$|([.\\+*[^\]$()?{}|])/g, (match2, metaChar) => metaChar ? `\\${metaChar}` : match2 === "/*" ? TAIL_WILDCARD_REG_EXP_STR : match2 === "*" ? ".*" : `/:${LABEL_REG_EXP_STR}`)}$`);
}
function findMiddleware(middleware, path) {
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) if (buildWildcardRegExp(k).test(path)) return [...middleware[k]];
}
var RegExpRouter = class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  #tries;
  constructor() {
    this.#middleware = { ["ALL"]: createNullObject() };
    this.#routes = { ["ALL"]: createNullObject() };
    this.#tries = { ["ALL"]: new Trie() };
  }
  #insertPath(method, path) {
    try {
      this.#tries[method].insert(path, !/\*|\/:/.test(path));
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    if (!middleware[method]) {
      this.#tries[method] = new Trie();
      for (const handlerMap of [middleware, routes]) {
        handlerMap[method] = createNullObject();
        for (const p in handlerMap["ALL"]) {
          handlerMap[method][p] = [...handlerMap["ALL"][p]];
          this.#insertPath(method, p);
        }
      }
    }
    if (path === "/*") path = "*";
    const methods = method === "ALL" ? Object.keys(middleware) : [method];
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      for (const m of methods) if (!middleware[m][path]) {
        this.#insertPath(m, path);
        middleware[m][path] = findMiddleware(middleware[m], path) || findMiddleware(middleware["ALL"], path) || [];
      }
      for (const handlerMap of [middleware, routes]) for (const m of methods) for (const p in handlerMap[m]) re.test(p) && handlerMap[m][p].push([handler, path]);
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (const path2 of paths) for (const m of methods) {
      if (!routes[m][path2]) {
        this.#insertPath(m, path2);
        routes[m][path2] = findMiddleware(middleware[m], path2) || findMiddleware(middleware["ALL"], path2) || [];
      }
      routes[m][path2].push([handler, path2]);
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = createNullObject();
    for (const method of Object.keys(this.#routes)) matchers[method] = this.#buildMatcher(method);
    this.#middleware = this.#routes = this.#tries = void 0;
    wildcardRegExpCache = createNullObject();
    return matchers;
  }
  #buildMatcher(method) {
    const middleware = this.#middleware[method];
    const routes = this.#routes[method];
    const trie = this.#tries[method];
    const staticMap = createNullObject();
    const handlerData = [];
    const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
    for (const r of [middleware, routes]) for (const path in r) {
      const handlers = r[path];
      const pathData = trie.paths[path];
      if (!pathData) {
        staticMap[path] = [handlers.map(([h]) => [h, createNullObject()]), emptyParam];
        continue;
      }
      handlerData[pathData[0]] = handlers.map(([h, handlerPath]) => [h, trie.paths[handlerPath][1].reduceRight((map, [key], i) => {
        map[key] = paramReplacementMap[pathData[1][i][1]];
        return map;
      }, createNullObject())]);
    }
    return [
      regexp,
      indexReplacementMap.map((i) => handlerData[i]),
      staticMap
    ];
  }
};

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    this.#routes.push([
      method,
      path,
      handler
    ]);
  }
  match(method, path) {
    if (!this.#routes) throw new Error("Fatal error");
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) router.add(...routes[i2]);
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) continue;
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) throw new Error("Fatal error");
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) throw new Error("No active router has been determined yet.");
    return this.#routers[0];
  }
};

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = createNullObject();
var order = 0;
var Node3 = class Node4 {
  #methods = [];
  #children = createNullObject();
  #patterns = [];
  #pattern;
  #params = emptyParams;
  insert(method, path, handler) {
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = /* @__PURE__ */ new Set();
    let i = 0;
    for (const p of parts) {
      const nextP = parts[++i];
      const pattern = getPattern(p, nextP) || (nextP === void 0 && p && p.indexOf("*") === p.length - 1 ? p : null);
      const isParam = Array.isArray(pattern);
      const key = isParam ? pattern[0] : pattern || p;
      const child = curNode.#children[key] ||= new Node4();
      if (pattern && !child.#pattern) {
        child.#pattern = pattern;
        curNode.#patterns.push(child);
      }
      curNode = child;
      if (isParam) possibleKeys.add(pattern[1]);
    }
    curNode.#methods.push({ [method]: {
      handler,
      possibleKeys: [...possibleKeys],
      score: ++order
    } });
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m["ALL"];
      if (handlerSet) {
        handlerSet.params = createNullObject();
        handlerSets.push(handlerSet);
        for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
          const key = handlerSet.possibleKeys[i2];
          handlerSet.params[key] = params?.[key] && !i2 ? params[key] : nodeParams[key] ?? params?.[key];
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    let curNodes = [this];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else tempNodes.push(nextNode);
        }
        for (const child of node.#patterns) {
          const pattern = child.#pattern;
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (typeof pattern === "string") {
            if (pattern === "*" || part.startsWith(pattern.slice(0, -1))) {
              this.#pushHandlerSets(handlerSets, child, method, node.#params);
              if (pattern === "*") {
                child.#params = params;
                tempNodes.push(child);
              }
            }
            continue;
          }
          const [, name, matcher] = pattern;
          if (!part && matcher === true) continue;
          if (matcher !== true) {
            if (!partOffsets) {
              partOffsets = [];
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.slice(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (m[0].length === restPathString.length && child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, node.#params, params);
              for (const _ in child.#children) {
                child.#params = params;
                const componentCount = m[0].match(/\//g)?.length ?? 0;
                (curNodesQueue[componentCount] ||= []).push(child);
                break;
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, params, node.#params);
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets[1]) handlerSets.sort((a, b) => {
      return a.score - b.score;
    });
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  name = "TrieRouter";
  #node = new Node3();
  add(method, path, handler) {
    for (const result of checkOptionalParameter(path) || [path]) this.#node.insert(method, result, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// node_modules/hono/dist/hono.js
var Hono3 = class extends Hono {
  /**
  * Creates an instance of the Hono class.
  *
  * @param options - Optional configuration options for the Hono instance.
  */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] });
  }
};

// node_modules/hono/dist/middleware/cors/index.js
var cors = (options) => {
  const opts = {
    origin: "*",
    allowMethods: [
      "GET",
      "HEAD",
      "PUT",
      "POST",
      "DELETE",
      "PATCH",
      "QUERY"
    ],
    allowHeaders: [],
    exposeHeaders: [],
    ...options
  };
  const exposeHeadersStr = opts.exposeHeaders?.length ? opts.exposeHeaders.join(",") : void 0;
  const allowHeadersStr = opts.allowHeaders?.length ? opts.allowHeaders.join(",") : void 0;
  const findAllowOrigin = ((optsOrigin) => {
    if (typeof optsOrigin === "string") {
      if (optsOrigin === "*") return () => optsOrigin;
      else return (origin) => optsOrigin === origin ? origin : null;
    } else if (typeof optsOrigin === "function") return optsOrigin;
    else return (origin) => optsOrigin.includes(origin) ? origin : null;
  })(opts.origin);
  const findAllowMethods = ((optsAllowMethods) => {
    if (typeof optsAllowMethods === "function") return async (origin, c) => (await optsAllowMethods(origin, c)).join(",");
    else if (Array.isArray(optsAllowMethods)) {
      const methodsStr = optsAllowMethods.join(",");
      return () => methodsStr;
    } else return () => "";
  })(opts.allowMethods);
  return async function cors2(c, next) {
    function set(key, value) {
      c.res.headers.set(key, value);
    }
    const allowOrigin = await findAllowOrigin(c.req.header("origin") || "", c);
    if (allowOrigin) set("Access-Control-Allow-Origin", allowOrigin);
    if (opts.credentials) set("Access-Control-Allow-Credentials", "true");
    if (exposeHeadersStr) set("Access-Control-Expose-Headers", exposeHeadersStr);
    if (c.req.method === "OPTIONS") {
      if (opts.origin !== "*") c.res.headers.append("Vary", "Origin");
      if (opts.maxAge != null) set("Access-Control-Max-Age", opts.maxAge.toString());
      const allowMethods = await findAllowMethods(c.req.header("origin") || "", c);
      if (allowMethods) set("Access-Control-Allow-Methods", allowMethods);
      let headersStr = allowHeadersStr;
      if (!headersStr) {
        const requestHeaders = c.req.header("Access-Control-Request-Headers");
        if (requestHeaders) headersStr = requestHeaders.split(",").map((h) => h.trim()).join(",");
      }
      if (headersStr) {
        set("Access-Control-Allow-Headers", headersStr);
        c.res.headers.append("Vary", "Access-Control-Request-Headers");
      }
      c.res.headers.delete("Content-Length");
      c.res.headers.delete("Content-Type");
      return new Response(null, {
        headers: c.res.headers,
        status: 204,
        statusText: "No Content"
      });
    }
    await next();
    if (opts.origin !== "*") c.header("Vary", "Origin", { append: true });
  };
};

// src/db.ts
var JSON_COLS = /* @__PURE__ */ new Set([
  "cats",
  "offerQueue",
  "offerSkipped",
  "offerMissed",
  "stops",
  "viewedBy",
  "payload",
  "data"
]);
function nowExpr(mod) {
  return `strftime('%Y-%m-%dT%H:%M:%fZ','now'${mod ? `,'${mod}'` : ""})`;
}
function translate(input) {
  let s = input;
  s = s.replace(/date_trunc\(\s*'month'\s*,\s*NOW\(\)\s*\)/gi, nowExpr("start of month"));
  s = s.replace(/NOW\(\)\s*-\s*INTERVAL\s*'([^']+)'/gi, (_m, iv) => nowExpr("-" + iv));
  s = s.replace(/\bNOW\(\)/gi, nowExpr());
  s = s.replace(/to_timestamp\(([^)]+)\)/gi, (_m, a) => `strftime('%Y-%m-%dT%H:%M:%fZ',${a},'unixepoch')`);
  s = s.replace(/\bTIMESTAMPTZ\b/gi, "TEXT");
  s = s.replace(/\bJSONB\b/gi, "TEXT");
  s = s.replace(/\bBOOLEAN\b/gi, "INTEGER");
  s = s.replace(/\bNUMERIC\b/gi, "REAL");
  s = s.replace(/\bILIKE\b/gi, "LIKE");
  s = s.replace(/ADD COLUMN IF NOT EXISTS/gi, "ADD COLUMN");
  s = s.replace(/gen_random_uuid\(\)/gi, () => `'${crypto.randomUUID()}'`);
  s = s.replace(/::\s*[A-Za-z_][A-Za-z0-9_]*(?:\[\])?/g, "");
  return s;
}
function normalize(v) {
  if (v === void 0) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}
var d1metrics = { queries: 0, rowsRead: 0, rowsWritten: 0, changes: 0, ms: 0, writesBy: {}, readsBy: {} };
function resetD1Metrics() {
  d1metrics.queries = 0;
  d1metrics.rowsRead = 0;
  d1metrics.rowsWritten = 0;
  d1metrics.changes = 0;
  d1metrics.ms = 0;
  d1metrics.writesBy = {};
  d1metrics.readsBy = {};
}
function labelOf(q) {
  const m = q.match(/^\s*(insert\s+into|update|delete\s+from|select)\s+["`]?([A-Za-z_]+)/i);
  if (!m) return q.slice(0, 24);
  return m[1].split(/\s+/)[0].toUpperCase() + " " + m[2];
}
function makeSql(db) {
  return async function sql(strings, ...values) {
    let query = strings[0];
    for (let i = 0; i < values.length; i++) query += "?" + strings[i + 1];
    query = translate(query);
    const stmt = values.length ? db.prepare(query).bind(...values.map(normalize)) : db.prepare(query);
    const res = await stmt.all();
    const meta = res && res.meta;
    if (meta) {
      d1metrics.queries++;
      d1metrics.rowsRead += meta.rows_read || 0;
      d1metrics.rowsWritten += meta.rows_written || 0;
      d1metrics.changes += meta.changes || 0;
      d1metrics.ms += meta.duration || 0;
      const lbl = labelOf(query);
      if (meta.rows_written) d1metrics.writesBy[lbl] = (d1metrics.writesBy[lbl] || 0) + meta.rows_written;
      if (meta.rows_read) d1metrics.readsBy[lbl] = (d1metrics.readsBy[lbl] || 0) + meta.rows_read;
    }
    const rows = res && res.results || [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      for (const k of Object.keys(row)) {
        if (JSON_COLS.has(k) && typeof row[k] === "string") {
          try {
            row[k] = JSON.parse(row[k]);
          } catch {
          }
        }
      }
    }
    return rows;
  };
}

// src/ratelimit.ts
function newBucket(capacity = 100, refillPerSec = 10) {
  return { tokens: capacity, capacity, refillPerSec, lastRefill: Date.now() };
}
function tryConsume(bucket, n = 1) {
  const now = Date.now();
  const gained = (now - bucket.lastRefill) / 1e3 * bucket.refillPerSec;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + gained);
  bucket.lastRefill = now;
  if (bucket.tokens < n) return false;
  bucket.tokens -= n;
  return true;
}

// src/conn-limit.ts
var WS_MAX_MESSAGE_BYTES = 64 * 1024;

// src/index.ts
var app = new Hono3();
app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
var RATE_LIMIT_WINDOW_MS = 6e4;
var RATE_LIMIT_MAX = 100;
var rateLimitHits = /* @__PURE__ */ new Map();
function clientIp(c) {
  return c.req.header("CF-Connecting-IP") || c.req.header("X-Real-IP") || "0.0.0.0";
}
function rateLimitCleanup() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitHits.entries()) {
    if (now > entry.resetAt) rateLimitHits.delete(ip);
  }
}
setInterval(rateLimitCleanup, 6e4);
app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path === "/ping" || path === "/api/v1/health" || path === "/api/v1/auth/guest") return next();
  const ip = clientIp(c);
  const now = Date.now();
  const entry = rateLimitHits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitHits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return c.json(
      { message: "Demasiados pedidos. Tenta de novo dentro de momentos.", retryAfterSec: Math.ceil((entry.resetAt - now) / 1e3) },
      429,
      { "Retry-After": String(Math.ceil((entry.resetAt - now) / 1e3)) }
    );
  }
  return next();
});
function b64url(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function expSeconds(exp) {
  const m = /^(\d+)([smhd])$/.exec(exp || "7d");
  if (!m) return 7 * 86400;
  const n = Number(m[1]);
  return m[2] === "s" ? n : m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n * 86400;
}
async function signJwt(payload, secret, exp) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1e3);
  const body = { ...payload, iat: now, exp: now + expSeconds(exp) };
  const h = b64url(JSON.stringify(header));
  const b = b64url(JSON.stringify(body));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${b}`));
  return `${h}.${b}.${b64url(sig)}`;
}
async function verifyJwt(token, secret) {
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) throw new Error("bad token");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, unb64url(s), new TextEncoder().encode(`${h}.${b}`));
  if (!ok) throw new Error("bad sig");
  const payload = JSON.parse(new TextDecoder().decode(unb64url(b)));
  if (payload.exp && Math.floor(Date.now() / 1e3) > payload.exp) throw new Error("expired");
  return payload;
}
var PBKDF2_ITER = 1e4;
async function pbkdf2Bits(pw, salt, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(pw, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(bits)}`;
}
async function verifyPassword(pw, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iter = parseInt(parts[1], 10);
  if (!Number.isFinite(iter) || iter < 1e3) return false;
  const want = unb64url(parts[3]);
  const got = await pbkdf2Bits(pw, unb64url(parts[2]), iter);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
function withoutHash(u) {
  if (!u) return u;
  const { passwordHash, passwordhash, ...safe } = u;
  return safe;
}
function havKm(aLa, aLo, bLa, bLo) {
  const R = 6371, t = Math.PI / 180;
  const dLa = (bLa - aLa) * t, dLo = (bLo - aLo) * t;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(aLa * t) * Math.cos(bLa * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function pinForTrip(id) {
  let h = 0;
  for (const c of String(id || "")) h = h * 31 + c.charCodeAt(0) >>> 0;
  return String(1e3 + h % 9e3);
}
var BASE_FARE = 5;
var PER_KM = 2.5;
var RIDE_MULT = { ECONOMY: 1, COMFORT: 1.35, PREMIUM: 1.7 };
async function getCategories(sql) {
  const rows = await sql`SELECT code, name, color, mult FROM ride_categories ORDER BY sort, code`;
  return rows.map((r) => ({ code: r.code, name: r.name, color: r.color, mult: Number(r.mult) }));
}
var CAT_CACHE = null;
var CAT_TTL_MS = 60 * 1e3;
function bustCatCache() {
  CAT_CACHE = null;
}
async function catMaps(sql) {
  if (CAT_CACHE && Date.now() - CAT_CACHE.at < CAT_TTL_MS) return CAT_CACHE.data;
  const byCode = { ECONOMY: "Econ\xF3mico", COMFORT: "Conforto", PREMIUM: "Fam\xEDlia" };
  const byName = { "Econ\xF3mico": "ECONOMY", "Conforto": "COMFORT", "Fam\xEDlia": "PREMIUM" };
  const mults = { ...RIDE_MULT };
  try {
    for (const c of await getCategories(sql)) {
      byCode[c.code] = c.name;
      byName[c.name] = c.code;
      mults[c.code] = c.mult;
    }
  } catch {
  }
  const data = { byCode, byName, mults };
  CAT_CACHE = { at: Date.now(), data };
  return data;
}
function surgeNow() {
  const h = (/* @__PURE__ */ new Date()).getHours();
  if (h >= 7 && h <= 9 || h >= 17 && h <= 20) return 1.3;
  if (h >= 23 || h <= 2) return 1.2;
  return 1;
}
async function requireAuth(c, next) {
  const ah = c.req.header("Authorization") || "";
  const token = ah.startsWith("Bearer ") ? ah.slice(7) : "";
  if (!token) return c.json({ message: "N\xE3o autenticado." }, 401);
  try {
    const p = await verifyJwt(token, c.env.JWT_SECRET);
    c.set("user", p);
    await next();
  } catch {
    return c.json({ message: "Sess\xE3o inv\xE1lida." }, 401);
  }
}
app.get("/ping", (c) => c.json({ ok: true, ts: Date.now(), worker: true }));
app.get("/api/v1/health", (c) => c.json({ ok: true, ts: Date.now() }));
app.get("/api", (c) => c.json({ name: "LadiesGo! API", status: "online", runtime: "cloudflare-workers" }));
var geoMetrics = { calls: 0, sets: 0, gets: 0, alls: 0, dels: 0 };
function resetGeoMetrics() {
  geoMetrics.calls = 0;
  geoMetrics.sets = 0;
  geoMetrics.gets = 0;
  geoMetrics.alls = 0;
  geoMetrics.dels = 0;
}
app.get("/debug/d1", (c) => {
  const key = c.env.DEBUG_KEY;
  if (!key || c.req.query("key") !== key) return c.json({ message: "Not found." }, 404);
  return c.json({ ...d1metrics, rowsPerQuery: d1metrics.queries ? +(d1metrics.rowsRead / d1metrics.queries).toFixed(2) : 0, geo: { ...geoMetrics } });
});
app.post("/debug/d1/reset", (c) => {
  const key = c.env.DEBUG_KEY;
  if (!key || c.req.query("key") !== key) return c.json({ message: "Not found." }, 404);
  resetD1Metrics();
  resetGeoMetrics();
  return c.json({ ok: true });
});
app.get("/debug/geo", (c) => {
  const key = c.env.DEBUG_KEY;
  if (!key || c.req.query("key") !== key) return c.json({ message: "Not found." }, 404);
  return c.json({ ...geoMetrics });
});
app.post("/api/v1/auth/guest", async (c) => {
  const sql = makeSql(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  const phone = `+guest${[...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  const rows = await sql`INSERT INTO users (id, phone, role, "isVerified", name, "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, ${phone}, 'PASSENGER', true, ${String(body?.name || "Guest").slice(0, 60)}, NOW(), NOW()) RETURNING id, phone, name, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt"`;
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || "7d");
  return c.json({ user: withoutHash(user), accessToken });
});
app.post("/api/v1/auth/login", async (c) => {
  const { phone, password } = await c.req.json().catch(() => ({}));
  const cleanPhone = String(phone || "").trim();
  if (!cleanPhone || !password) return c.json({ message: "N\xFAmero ou senha incorretos" }, 401);
  const sql = makeSql(c.env.DB);
  const rows = await sql`SELECT id, phone, "passwordHash", name, email, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt" FROM users WHERE phone = ${cleanPhone} AND "isActive" = true LIMIT 1`;
  if (!rows.length || !await verifyPassword(String(password), rows[0].passwordHash)) return c.json({ message: "N\xFAmero ou senha incorretos" }, 401);
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || "7d");
  return c.json({ user: withoutHash(user), accessToken, isNew: false });
});
app.post("/api/v1/auth/register", async (c) => {
  const sql = makeSql(c.env.DB);
  const { phone, password, name, role } = await c.req.json().catch(() => ({}));
  const cleanPhone = String(phone || "").trim();
  if (!cleanPhone || !password || String(password).length < 4)
    return c.json({ message: "N\xFAmero ou senha inv\xE1lidos." }, 400);
  const finalRole = String(role || "PASSENGER").toUpperCase() === "DRIVER" ? "DRIVER" : "PASSENGER";
  const exists = await sql`SELECT id FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
  if (exists.length) return c.json({ message: "N\xFAmero j\xE1 registado. Entra com a tua senha." }, 409);
  const rows = await sql`INSERT INTO users (id, phone, "passwordHash", name, role, "isVerified", "updatedAt") VALUES (gen_random_uuid()::text, ${cleanPhone}, ${await hashPassword(String(password))}, ${String(name || "").slice(0, 60) || null}, ${finalRole}, true, NOW()) RETURNING id, phone, name, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt"`;
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || "7d");
  return c.json({ user: withoutHash(user), accessToken, isNew: true });
});
app.post("/api/v1/auth/refresh-token", async (c) => {
  const ah = c.req.header("Authorization") || "";
  const token = ah.startsWith("Bearer ") ? ah.slice(7) : "";
  if (!token) return c.json({ message: "N\xE3o autenticado." }, 401);
  try {
    const p = await verifyJwt(token, c.env.JWT_SECRET);
    const sql = makeSql(c.env.DB);
    const rows = await sql`SELECT id, phone, role FROM users WHERE id = ${p.sub} LIMIT 1`;
    if (!rows.length) return c.json({ message: "N\xE3o autenticado." }, 401);
    const accessToken = await signJwt({ sub: rows[0].id, phone: rows[0].phone, role: rows[0].role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || "7d");
    return c.json({ accessToken });
  } catch {
    return c.json({ message: "Sess\xE3o inv\xE1lida." }, 401);
  }
});
app.post("/api/v1/auth/change-password", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const { newPassword } = await c.req.json().catch(() => ({}));
  if (!newPassword || String(newPassword).length < 4) return c.json({ message: "A senha deve ter pelo menos 4 caracteres" }, 400);
  await sql`UPDATE users SET "passwordHash" = ${await hashPassword(String(newPassword))}, "mustChangePassword" = false, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  return c.json({ success: true });
});
app.get("/api/v1/users/profile", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const rows = await sql`SELECT id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance" FROM users WHERE id = ${user.sub} LIMIT 1`;
  if (!rows.length) return c.json({ message: "N\xE3o encontrado." }, 404);
  return c.json(rows[0]);
});
app.put("/api/v1/users/profile", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  let photo = null;
  if (body?.profilePhoto != null) {
    photo = String(body.profilePhoto);
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photo)) return c.json({ message: "Foto invalida." }, 400);
    if (photo.length > 2 * 1024 * 1024) return c.json({ message: "Foto demasiado grande." }, 413);
  }
  if (body?.fcmToken) {
    try {
      await sql`UPDATE users SET "fcmToken" = NULL, "updatedAt" = NOW() WHERE "fcmToken" = ${body.fcmToken} AND id != ${user.sub}`;
    } catch {
    }
  }
  let rows = await sql`UPDATE users SET name = COALESCE(${body?.name ?? null}, name), "fcmToken" = COALESCE(${body?.fcmToken ?? null}, "fcmToken"), "profilePhoto" = COALESCE(${photo}, "profilePhoto"), "updatedAt" = NOW() WHERE id = ${user.sub} AND (COALESCE(${body?.name ?? null}, name) IS NOT name OR COALESCE(${body?.fcmToken ?? null}, "fcmToken") IS NOT "fcmToken" OR COALESCE(${photo}, "profilePhoto") IS NOT "profilePhoto") RETURNING id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance"`;
  if (!rows.length) rows = await sql`SELECT id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance" FROM users WHERE id = ${user.sub} LIMIT 1`;
  let tgOn = false;
  if (photo) {
    tgOn = !!((c.env.TG_BOT_TOKEN || c.env.TELEGRAM_BOT_TOKEN) && (c.env.TG_CHAT_ID || c.env.TELEGRAM_CHAT_ID));
    if (tgOn) {
      const u0 = rows[0] || {};
      const caption = `LadiesGo \xB7 foto de ${u0.name || u0.phone || ""} (${u0.role || ""})`;
      try {
        c.executionCtx.waitUntil(tgSendPhoto(c.env, photo, caption).catch(() => false));
      } catch {
        tgSendPhoto(c.env, photo, caption).catch(() => false);
      }
    }
  }
  return c.json({ ...rows[0] || {}, telegram: photo ? tgOn : void 0 });
});
app.delete("/api/v1/users/push-token", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  await sql`UPDATE users SET "fcmToken" = NULL, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${user.sub}`;
  return c.json({ ok: true });
});
app.get("/api/v1/users/trips/history", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const rows = await sql`SELECT id, "dropoffAddress", "fareEstimate", status, "createdAt" FROM trips WHERE "passengerId" = ${user.sub} ORDER BY "createdAt" DESC LIMIT 20 OFFSET ${(page - 1) * 20}`;
  return c.json({ trips: rows });
});
app.delete("/api/v1/users/me", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  await sql`UPDATE users SET "isActive" = false, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  return c.json({ success: true });
});
app.post("/api/v1/users/report", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const { reportedUserId, reason, tripId } = await c.req.json().catch(() => ({}));
  const rid = String(reportedUserId || "").slice(0, 64);
  const why = String(reason || "").slice(0, 500);
  if (!rid || !why) return c.json({ message: "Dados inv\xE1lidos." }, 400);
  await sql`
    INSERT INTO reports (id, "reporterId", "reportedUserId", reason, "tripId", "createdAt")
    VALUES (gen_random_uuid()::text, ${user.sub}, ${rid}, ${why}, ${tripId ? String(tripId).slice(0, 64) : null}, NOW())
  `;
  return c.json({ success: true });
});
app.get("/api/v1/drivers/status", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const rows = await sql`SELECT d.*, u.name FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."userId" = ${user.sub} LIMIT 1`;
  if (!rows.length) return c.json({ message: "Motorista n\xE3o registada." }, 404);
  return c.json({ ...rows[0], isOnline: !!rows[0].isOnline, totalEarnings: Number(rows[0].totalEarnings || 0) });
});
app.put("/api/v1/drivers/toggle-online", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const { isOnline } = await c.req.json().catch(() => ({}));
  if (isOnline) {
    const w = await sql`SELECT "walletBlocked" FROM users WHERE id = ${user.sub} LIMIT 1`;
    if (w.length && Number(w[0].walletBlocked || 0)) return c.json({ message: "Saldo negativo. Carrega a tua conta para voltares a ficar online." }, 403);
  }
  let rows = await sql`UPDATE drivers SET "isOnline" = ${!!isOnline}, "updatedAt" = NOW() WHERE "userId" = ${user.sub} AND "isOnline" IS NOT ${!!isOnline} RETURNING "isOnline"`;
  if (!rows.length) rows = await sql`SELECT "isOnline" FROM drivers WHERE "userId" = ${user.sub} LIMIT 1`;
  if (!rows.length) return c.json({ message: "Motorista n\xE3o registada." }, 404);
  return c.json({ isOnline: !!rows[0].isOnline });
});
app.get("/api/v1/drivers/wallet", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const u = await sql`SELECT "walletBalance", "negTrips", "walletBlocked", phone FROM users WHERE id = ${user.sub} LIMIT 1`;
  if (!u.length) return c.json({ message: "Conta n\xE3o encontrada." }, 404);
  const tx = await sql`SELECT type, amount, "balanceAfter", "tripId", "createdAt" FROM wallet_tx WHERE "userId" = ${user.sub} ORDER BY "createdAt" DESC LIMIT 30`;
  return c.json({
    balance: money(u[0].walletBalance),
    negTrips: Number(u[0].negTrips || 0),
    limit: NEG_TRIP_LIMIT,
    blocked: !!Number(u[0].walletBlocked || 0),
    phone: u[0].phone,
    commissionRate: COMMISSION_RATE,
    transactions: tx.map((t) => ({ ...t, amount: money(t.amount), balanceAfter: money(t.balanceAfter) }))
  });
});
app.put("/api/v1/drivers/location", requireAuth, async (c) => {
  const user = c.get("user");
  const { lat, lng } = await c.req.json().catch(() => ({}));
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: "Posi\xE7\xE3o inv\xE1lida." }, 400);
  await geoSet(c.env, { userId: user.sub, lat: la, lng: lo });
  return c.json({ ok: true });
});
app.get("/api/v1/drivers/nearby", async (c) => {
  const sql = makeSql(c.env.DB);
  const lat = Number(c.req.query("lat")), lng = Number(c.req.query("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return c.json({ message: "Pedido inv\xE1lido." }, 400);
  const pos = await geoAll(c.env);
  const byUser = /* @__PURE__ */ new Map();
  for (const p of pos) if (p && p.userId) byUser.set(String(p.userId), p);
  let rows;
  try {
    rows = await sql`SELECT d.id, d."userId", u.name, d.cats FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' LIMIT 100`;
  } catch {
    rows = await sql`SELECT d.id, d."userId", u.name FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' LIMIT 100`;
  }
  const out = rows.map((d) => {
    const p = byUser.get(String(d.userId));
    if (!p || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) return null;
    return { id: d.id, currentLat: Number(p.lat), currentLng: Number(p.lng), lat: Number(p.lat), lng: Number(p.lng), name: d.name, cats: Array.isArray(d.cats) ? d.cats.map((x) => String(x)) : void 0, distanceKm: Math.round(havKm(lat, lng, Number(p.lat), Number(p.lng)) * 10) / 10 };
  }).filter(Boolean).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 20);
  return c.json({ drivers: out });
});
app.get("/api/v1/drivers/earnings", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const d = await sql`SELECT id, "totalEarnings", "totalTrips" FROM drivers WHERE "userId" = ${user.sub} LIMIT 1`;
  return c.json({ totalEarnings: Number(d[0]?.totalEarnings || 0), totalTrips: Number(d[0]?.totalTrips || 0), trips: [] });
});
app.post("/api/v1/drivers/register", requireAuth, async (c) => c.json({ message: "Registo via painel admin." }, 400));
app.put("/api/v1/drivers/vehicle", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ message: "S\xF3 o admin edita viaturas." }, 403);
  const b = await c.req.json().catch(() => ({}));
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: "Sem registo de motorista." }, 404);
  const plate = String(b.carPlate || "").trim().slice(0, 12);
  if (plate) {
    const clash = await sql`SELECT id FROM drivers WHERE "carPlate" = ${plate} AND id != ${did} LIMIT 1`;
    if (clash.length) return c.json({ message: "Matr\xEDcula j\xE1 usada noutra viatura." }, 409);
  }
  const lic = String(b.licenseNumber || "").trim().slice(0, 30) || null;
  if (lic) {
    const clashL = await sql`SELECT id FROM drivers WHERE "licenseNumber" = ${lic} AND id != ${did} LIMIT 1`;
    if (clashL.length) return c.json({ message: "Carta j\xE1 usada noutra conta." }, 409);
  }
  const year = parseInt(b.carYear, 10);
  await sql`
    UPDATE drivers SET "carMake" = COALESCE(${String(b.carMake || "").slice(0, 40) || null}, "carMake"),
      "carModel" = COALESCE(${String(b.carModel || "").slice(0, 40) || null}, "carModel"),
      "carColor" = COALESCE(${String(b.carColor || "").slice(0, 20) || null}, "carColor"),
      "carPlate" = COALESCE(${plate || null}, "carPlate"),
      "licenseNumber" = COALESCE(${lic}, "licenseNumber"),
      "carYear" = COALESCE(${Number.isInteger(year) ? year : null}, "carYear"),
      "updatedAt" = NOW() WHERE id = ${did}`;
  return c.json({ ok: true });
});
app.put("/api/v1/admin/drivers/:id", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  const cur = await sql`SELECT d.*, u.name AS uname FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${id} LIMIT 1`;
  if (!cur.length) return c.json({ message: "Motorista n\xE3o encontrada." }, 404);
  const t = cur[0];
  const plate = String(b.carPlate || "").trim().slice(0, 12);
  if (plate) {
    const clash = await sql`SELECT id FROM drivers WHERE "carPlate" = ${plate} AND id != ${id} LIMIT 1`;
    if (clash.length) return c.json({ message: "Matr\xEDcula j\xE1 usada noutra viatura." }, 409);
  }
  const lic = String(b.licenseNumber || "").trim().slice(0, 30) || null;
  if (lic) {
    const clashL = await sql`SELECT id FROM drivers WHERE "licenseNumber" = ${lic} AND id != ${id} LIMIT 1`;
    if (clashL.length) return c.json({ message: "Carta j\xE1 usada noutra conta." }, 409);
  }
  const year = parseInt(b.carYear, 10);
  if (b.carYear !== void 0 && b.carYear !== "" && b.carYear !== null && !Number.isInteger(year)) return c.json({ message: "Ano inv\xE1lido." }, 400);
  const nm = String(b.name || "").trim().slice(0, 60);
  if (nm && t.userId) await sql`UPDATE users SET name = ${nm}, "updatedAt" = NOW() WHERE id = ${t.userId}`;
  const rows = await sql`
    UPDATE drivers SET "carMake" = COALESCE(${String(b.carMake || "").slice(0, 40) || null}, "carMake"),
      "carModel" = COALESCE(${String(b.carModel || "").slice(0, 40) || null}, "carModel"),
      "carColor" = COALESCE(${String(b.carColor || "").slice(0, 20) || null}, "carColor"),
      "carPlate" = COALESCE(${plate || null}, "carPlate"),
      "licenseNumber" = COALESCE(${lic}, "licenseNumber"),
      "carYear" = COALESCE(${Number.isInteger(year) ? year : null}, "carYear"),
      "updatedAt" = NOW() WHERE id = ${id} RETURNING *`;
  return c.json(rows[0]);
});
app.get("/api/v1/ratings/pending", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  try {
    const did = await driverIdFor(sql, user.sub);
    const rows = did ? await sql`SELECT t.id AS "tripId" FROM trips t LEFT JOIN ratings r ON r.id = t.id || ':' || ${user.sub} WHERE t.status = 'COMPLETED' AND (t."passengerId" = ${user.sub} OR t."driverId" = ${did}) AND r.id IS NULL ORDER BY t."completedAt" DESC NULLS LAST, t."createdAt" DESC LIMIT 5` : await sql`SELECT t.id AS "tripId" FROM trips t LEFT JOIN ratings r ON r.id = t.id || ':' || ${user.sub} WHERE t.status = 'COMPLETED' AND t."passengerId" = ${user.sub} AND r.id IS NULL ORDER BY t."completedAt" DESC NULLS LAST, t."createdAt" DESC LIMIT 5`;
    return c.json({ pendings: rows.map((x) => ({ tripId: x.tripId })) });
  } catch (e) {
    return c.json({ pendings: [] });
  }
});
app.get("/api/v1/ratings/mine", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  try {
    const did = await driverIdFor(sql, user.sub);
    const rows = did ? await sql`SELECT r.score, r.comment, r."createdAt", u.name AS "raterName" FROM ratings r JOIN trips t ON t.id = r."tripId" LEFT JOIN users u ON u.id = r."raterId" WHERE t."driverId" = ${did} ORDER BY r."createdAt" DESC LIMIT 30` : await sql`SELECT r.score, r.comment, r."createdAt", u.name AS "raterName" FROM ratings r LEFT JOIN users u ON u.id = r."raterId" WHERE r."ratedId" = ${user.sub} ORDER BY r."createdAt" DESC LIMIT 30`;
    const scores = rows.map((x) => Number(x.score) || 0).filter((s) => s > 0);
    const avg = scores.length ? Math.round(scores.reduce((a, s) => a + s, 0) / scores.length * 10) / 10 : 5;
    return c.json({ ratings: rows, avg, count: rows.length });
  } catch (e) {
    return c.json({ ratings: [], avg: 5, count: 0 });
  }
});
app.post("/api/v1/drivers/position", async (c) => {
  const sql = makeSql(c.env.DB);
  const b = await c.req.json().catch(() => ({}));
  const userId = String(b.id || "");
  if (!userId) return c.json({ message: "Motorista inv\xE1lida." }, 400);
  if (b.offline) {
    await geoDel(c.env, userId);
    await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
    return c.json({ ok: true });
  }
  const la = Number(b.lat), lo = Number(b.lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: "Posi\xE7\xE3o inv\xE1lida." }, 400);
  const cats = Array.isArray(b.cats) ? b.cats.map((x) => String(x).slice(0, 30)).slice(0, 6) : null;
  const wasOnline = await geoSet(c.env, { userId, lat: la, lng: lo, cats, online: true });
  if (!wasOnline) {
    const rows = await sql`
      UPDATE drivers SET "isOnline" = true, cats = COALESCE(${cats ? JSON.stringify(cats) : null}::jsonb, cats), "updatedAt" = NOW()
      WHERE "userId" = ${userId} RETURNING id`;
    if (!rows.length) return c.json({ message: "Motorista n\xE3o registada." }, 404);
  }
  return c.json({ ok: true });
});
app.post("/api/v1/trips/estimate", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dist = havKm(Number(body.pickupLat), Number(body.pickupLng), Number(body.dropoffLat), Number(body.dropoffLng));
  const base = BASE_FARE + dist * PER_KM;
  const surge = surgeNow();
  const sql = makeSql(c.env.DB);
  const { mults } = await catMaps(sql);
  const mult = mults[String(body.rideType || "ECONOMY")] ?? 1;
  const options = Object.keys(mults).map((type) => ({ type, fare: Math.round(base * surge * mults[type] * 100) / 100 }));
  return c.json({ distanceKm: Math.round(dist * 10) / 10, estimatedFare: Math.round(base * surge * mult * 100) / 100, currency: "Kz", surgeMultiplier: surge, surgeActive: surge > 1, options });
});
app.post("/api/v1/trips/request", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const active = await sql`SELECT id, status FROM trips WHERE "passengerId" = ${user.sub} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') ORDER BY "createdAt" DESC LIMIT 1`;
  if (active.length && active[0].status !== "REQUESTED") return c.json({ message: "You already have an active trip. Complete or cancel it first." }, 400);
  if (active.length) await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = 'Replaced by new booking' WHERE id = ${active[0].id}`;
  const dist = havKm(Number(b.pickupLat), Number(b.pickupLng), Number(b.dropoffLat), Number(b.dropoffLng));
  const { mults, byCode } = await catMaps(sql);
  const fare = Math.round((BASE_FARE + dist * PER_KM) * surgeNow() * (mults[String(b.rideType || "ECONOMY")] ?? 1) * 100) / 100;
  let q = [];
  try {
    q = await buildOfferQueue(c.env, sql, Number(b.pickupLat), Number(b.pickupLng), String(b.rideType || "ECONOMY"));
  } catch {
  }
  const hasQ = q.length > 0;
  const expAt = hasQ ? new Date(Date.now() + OFFER_TTL_SEC * 1e3) : null;
  const rows = await sql`INSERT INTO trips (id, "passengerId", "pickupAddress", "pickupLat", "pickupLng", "dropoffAddress", "dropoffLat", "dropoffLng", status, "rideType", "fareEstimate", "distanceKm", "paymentMethod", "createdAt", "updatedAt", "offerQueue", "offerIdx", "offeredDriverId", "offeredAt", "offerExpiresAt", "offerBroadcast", "offerSkipped") VALUES (gen_random_uuid()::text, ${user.sub}, ${String(b.pickupAddress || "Luanda")}, ${Number(b.pickupLat)}, ${Number(b.pickupLng)}, ${String(b.dropoffAddress || "Luanda")}, ${Number(b.dropoffLat)}, ${Number(b.dropoffLng)}, 'REQUESTED', ${String(b.rideType || "ECONOMY")}, ${fare}, ${Math.round(dist * 10) / 10}, ${String(b.paymentMethod || "CASH")}, NOW(), NOW(), ${hasQ ? JSON.stringify(q) : null}, 0, ${hasQ ? q[0] : null}, ${hasQ ? (/* @__PURE__ */ new Date()).toISOString() : null}, ${expAt ? expAt.toISOString() : null}, ${hasQ ? 0 : 1}, ${hasQ ? "[]" : null}) RETURNING *`;
  hubPoke(c, [byCode[String(b.rideType || "ECONOMY")] || ""]);
  return c.json(rows[0]);
});
app.get("/api/v1/trips/incoming", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const qDriver = String(c.req.query("driverId") || "");
  try {
    const did = await driverIdFor(sql, qDriver || user.sub);
    if (!did) return c.json({ trips: [] });
    const { byCode } = await catMaps(sql);
    let myCats = null;
    try {
      const dr = await sql`SELECT cats, "isOnline" FROM drivers WHERE id = ${did} LIMIT 1`;
      if (!dr.length || !dr[0].isOnline) return c.json({ trips: [] });
      if (Array.isArray(dr[0].cats) && dr[0].cats.length) myCats = dr[0].cats.map((x) => String(x));
    } catch {
    }
    const rows = await sql`
      SELECT t.*, u.name AS passenger_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId"
      WHERE t.status = 'REQUESTED' AND t."createdAt" > NOW() - INTERVAL '10 minutes'
      ORDER BY t."createdAt" ASC LIMIT 40`;
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < 20; i--) {
      let r = rows[i];
      if (seen.has(r.passengerId)) continue;
      seen.add(r.passengerId);
      if (myCats && myCats.indexOf(byCode[r.rideType] || "") < 0) continue;
      if (offerSkippedOf(r).indexOf(did) >= 0) continue;
      const q = offerQueueOf(r);
      if (!q.length && !r.offeredDriverId) {
        out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || "Econ\xF3mico"));
        continue;
      }
      if (!r.offerBroadcast) {
        r = await advanceOfferIfNeeded(c.env, sql, r);
        if (offerSkippedOf(r).indexOf(did) >= 0) continue;
        if (r.offerBroadcast) {
          out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || "Econ\xF3mico"));
          continue;
        }
        if (String(r.offeredDriverId || "") !== did) continue;
      }
      out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || "Econ\xF3mico"));
    }
    return c.json({ trips: out });
  } catch (e) {
    console.error("incoming error:", e);
    return c.json({ trips: [] });
  }
});
app.get("/api/v1/trips/requests-live", async (c) => {
  let user = null;
  try {
    const ah = c.req.header("Authorization") || "";
    let tok = ah.startsWith("Bearer ") ? ah.slice(7) : "";
    if (!tok) tok = String(c.req.query("token") || "");
    if (tok) user = await verifyJwt(tok, c.env.JWT_SECRET);
  } catch {
  }
  if (!user?.sub) return c.json({ message: "N\xE3o autenticado." }, 401);
  if ((c.req.header("Upgrade") || "").toLowerCase() !== "websocket")
    return c.json({ message: "Usa WebSocket: GET com header Upgrade: websocket.", usage: "/api/v1/trips/requests-live" }, 426);
  const sql = makeSql(c.env.DB);
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: "S\xF3 motoristas." }, 403);
  let cats = [];
  try {
    const dr = await sql`SELECT cats FROM drivers WHERE id = ${did} LIMIT 1`;
    if (dr.length && Array.isArray(dr[0].cats)) cats = dr[0].cats.map((x) => String(x));
  } catch {
  }
  const ns = c.env.REQUESTSHUB;
  if (!ns || !ns.get) return c.json({ message: "Feed em tempo real indispon\xEDvel." }, 503);
  const stub = ns.get(ns.idFromName("requests:global"));
  const fwd = new Headers();
  for (const h of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set("X-User-Id", String(user.sub || ""));
  fwd.set("X-Driver-Id", did);
  fwd.set("X-Cats", JSON.stringify(cats));
  return stub.fetch(new Request("https://requests-hub/live", { method: "GET", headers: fwd }));
});
app.get("/api/v1/drivers/live-geo", async (c) => {
  let user = null;
  try {
    const ah = c.req.header("Authorization") || "";
    let tok = ah.startsWith("Bearer ") ? ah.slice(7) : "";
    if (!tok) tok = String(c.req.query("token") || "");
    if (tok) user = await verifyJwt(tok, c.env.JWT_SECRET);
  } catch {
  }
  if (!user?.sub) return c.json({ message: "N\xE3o autenticado." }, 401);
  if ((c.req.header("Upgrade") || "").toLowerCase() !== "websocket")
    return c.json({ message: "Usa WebSocket: GET com header Upgrade: websocket." }, 426);
  const ns = c.env.DRIVERGEO;
  if (!ns || !ns.get) return c.json({ message: "GPS ao vivo indispon\xEDvel." }, 503);
  const stub = ns.get(ns.idFromName("geo:global"));
  const fwd = new Headers();
  for (const h of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set("X-User-Id", String(user.sub || ""));
  return stub.fetch(new Request("https://geo/live", { method: "GET", headers: fwd }));
});
app.get("/api/v1/trips/history", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const p = String(c.req.query("passengerId") || "").slice(0, 64);
  const d = String(c.req.query("driverId") || "").slice(0, 64);
  try {
    let did;
    if (d) did = await driverIdFor(sql, d);
    let rows;
    if (p && did) rows = await sql`SELECT t.*, u.name AS passenger_name, du.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId" LEFT JOIN drivers dd ON dd.id = t."driverId" LEFT JOIN users du ON du.id = dd."userId" WHERE t."passengerId" = ${p} OR t."driverId" = ${did} ORDER BY t."createdAt" DESC LIMIT 30`;
    else if (p) rows = await sql`SELECT t.*, u.name AS passenger_name, du.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId" LEFT JOIN drivers dd ON dd.id = t."driverId" LEFT JOIN users du ON du.id = dd."userId" WHERE t."passengerId" = ${p} ORDER BY t."createdAt" DESC LIMIT 30`;
    else if (did) rows = await sql`SELECT t.*, u.name AS passenger_name, du.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId" LEFT JOIN drivers dd ON dd.id = t."driverId" LEFT JOIN users du ON du.id = dd."userId" WHERE t."driverId" = ${did} ORDER BY t."createdAt" DESC LIMIT 30`;
    else return c.json({ trips: [] });
    const { byCode } = await catMaps(sql);
    return c.json({ trips: rows.map((t) => ({
      id: t.id,
      dest: String(t.dropoffAddress || ""),
      fare: t.finalFare != null ? Number(t.finalFare) : Number(t.fareEstimate),
      cat: byCode[t.rideType] || "Econ\xF3mico",
      status: NEON2WEB[t.status] || t.status,
      by: t.cancelledBy || "",
      reason: t.cancelReason || "",
      other: d ? t.passenger_name || "" : t.driver_name || "",
      ts: t.createdAt ? new Date(t.createdAt).getTime() : null,
      from: t.pickupAddress || "",
      pay: t.paymentMethod === "CARD" ? "Cart\xE3o" : "Numer\xE1rio",
      stopsN: Array.isArray(t.stops) ? t.stops.length : 0,
      stops: (Array.isArray(t.stops) ? t.stops : []).map((x) => ({ n: String(x.n || "").slice(0, 60) }))
    })) });
  } catch (e) {
    console.error("history error:", e);
    return c.json({ trips: [] });
  }
});
app.get("/api/v1/trips/active", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const asPax = await sql`SELECT t.* FROM trips t WHERE t.status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') AND t."passengerId" = ${user.sub} ORDER BY t."createdAt" DESC LIMIT 1`;
  const asDrv = await sql`SELECT t.* FROM trips t JOIN drivers d ON d.id = t."driverId" WHERE t.status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') AND d."userId" = ${user.sub} ORDER BY t."createdAt" DESC LIMIT 1`;
  const a = asPax[0] || null, b = asDrv[0] || null;
  const ta = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
  return c.json(ta >= tb ? a : b);
});
async function notifyTripPush(env, tripId, status) {
  try {
    const ns = env.TRIPPUSH;
    if (!ns || !ns.get) return;
    const stub = ns.get(ns.idFromName(`trip:${tripId}`));
    await stub.fetch(new Request("https://trip-push/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }));
  } catch {
  }
}
function pushStatus(c, tripId, status) {
  try {
    c.executionCtx.waitUntil(notifyTripPush(c.env, tripId, status));
  } catch {
    notifyTripPush(c.env, tripId, status);
  }
}
async function pushPaxArrived(env, tripId) {
  try {
    const sql = makeSql(env.DB);
    const rows = await sql`SELECT "passengerId" FROM trips WHERE id = ${tripId} LIMIT 1`;
    if (!rows.length) return;
    const u = await sql`SELECT "fcmToken" FROM users WHERE id = ${rows[0].passengerId} LIMIT 1`;
    const tok = u[0]?.fcmToken;
    if (!tok || String(tok).indexOf("ExponentPushToken") !== 0) return;
    await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ to: tok, sound: "default", title: "\u{1F98B} A tua motorista chegou!", body: "Dita o teu c\xF3digo de seguran\xE7a para come\xE7ar a viagem.", data: { tripId, type: "arrived" } }]) });
  } catch {
  }
}
async function hubBroadcast(env, cats) {
  try {
    const ns = env.REQUESTSHUB;
    if (!ns || !ns.get) return;
    const stub = ns.get(ns.idFromName("requests:global"));
    await stub.fetch(new Request("https://requests-hub/broadcast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cats: cats && cats.length ? cats : null }) }));
  } catch {
  }
}
function hubPoke(c, cats) {
  try {
    c.executionCtx.waitUntil(hubBroadcast(c.env, cats));
  } catch {
    hubBroadcast(c.env, cats);
  }
}
var GEO_TTL_MS = 18 * 60 * 1e3;
function geoStub(env) {
  try {
    const ns = env.DRIVERGEO;
    return ns && ns.get ? ns.get(ns.idFromName("geo:global")) : null;
  } catch {
    return null;
  }
}
function geoFetch(env, path, init) {
  const s = geoStub(env);
  if (!s) return Promise.resolve(null);
  geoMetrics.calls++;
  return s.fetch(new Request("https://geo" + path, init)).catch(() => null);
}
async function geoSet(env, data) {
  geoMetrics.sets++;
  const r = await geoFetch(env, "/set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!r) return false;
  try {
    return !!(await r.json()).wasOnline;
  } catch {
    return false;
  }
}
async function geoDel(env, userId) {
  geoMetrics.dels++;
  await geoFetch(env, "/del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
}
async function geoGet(env, userId) {
  if (!userId) return null;
  geoMetrics.gets++;
  const r = await geoFetch(env, "/get?userId=" + encodeURIComponent(userId));
  if (!r) return null;
  try {
    const d = (await r.json()).driver;
    return d && Date.now() - Number(d.ts || 0) <= GEO_TTL_MS ? d : null;
  } catch {
    return null;
  }
}
async function geoAll(env) {
  geoMetrics.alls++;
  const r = await geoFetch(env, "/all");
  if (!r) return [];
  try {
    const arr = (await r.json()).drivers;
    const now = Date.now();
    return Array.isArray(arr) ? arr.filter((d) => now - Number(d.ts || 0) <= GEO_TTL_MS) : [];
  } catch {
    return [];
  }
}
app.get("/api/v1/trips/:id/live", async (c) => {
  const id = c.req.param("id");
  let user = null;
  try {
    const ah = c.req.header("Authorization") || "";
    let tok = ah.startsWith("Bearer ") ? ah.slice(7) : "";
    if (!tok) tok = String(c.req.query("token") || "");
    if (tok) user = await verifyJwt(tok, c.env.JWT_SECRET);
  } catch {
  }
  if (!user?.sub) return c.json({ message: "N\xE3o autenticado." }, 401);
  if ((c.req.header("Upgrade") || "").toLowerCase() !== "websocket")
    return c.json({ message: "Usa WebSocket: GET com header Upgrade: websocket.", usage: `/api/v1/trips/${id}/live` }, 426);
  const sql = makeSql(c.env.DB);
  const t = await sql`SELECT t."passengerId", d."userId" AS "driverUserId" FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${id} LIMIT 1`;
  if (!t.length) return c.json({ message: "Viagem n\xE3o encontrada." }, 404);
  const isDriver = !!t[0].driverUserId && t[0].driverUserId === user.sub;
  const isPax = t[0].passengerId === user.sub;
  if (!isDriver && !isPax) return c.json({ message: "Sem acesso a esta viagem." }, 403);
  const ns = c.env.TRIPPUSH;
  if (!ns || !ns.get) return c.json({ message: "Push em tempo real indispon\xEDvel." }, 503);
  const stub = ns.get(ns.idFromName(`trip:${id}`));
  const fwd = new Headers();
  for (const h of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set("X-Trip-Id", id);
  fwd.set("X-User-Id", String(user.sub || ""));
  fwd.set("X-Is-Driver", isDriver ? "1" : "0");
  return stub.fetch(new Request(`https://trip-push/${id}`, { method: "GET", headers: fwd }));
});
app.get("/api/v1/trips/:id", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql`SELECT t.*, d."currentLat" AS "driverLat", d."currentLng" AS "driverLng", d."userId" AS "driverUserId" FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${id} LIMIT 1`;
  if (!rows.length) return c.json({ message: "Viagem n\xE3o encontrada." }, 404);
  const t = rows[0];
  if (c.req.query("view") === "web") {
    const drv = await webDriverInfo(c.env, sql, t.driverId);
    const pu = await sql`SELECT name, phone, "profilePhoto" FROM users WHERE id = ${t.passengerId} LIMIT 1`;
    const pl = paxLive.get(t.id);
    const { byCode } = await catMaps(sql);
    return c.json({ ...webTripRow(t, drv, pu[0]?.name || "", (code) => byCode[code] || "Econ\xF3mico", pu[0]?.phone || "", pu[0]?.profilePhoto || ""), paxLive: pl && Date.now() - pl.ts < 6e4 && String(t.status) !== "IN_PROGRESS" ? { lat: pl.lat, lng: pl.lng } : null });
  }
  const liveD = t.driverUserId ? await geoGet(c.env, String(t.driverUserId)) : null;
  const dLat = liveD && Number.isFinite(Number(liveD.lat)) ? Number(liveD.lat) : t.driverLat != null ? Number(t.driverLat) : null;
  const dLng = liveD && Number.isFinite(Number(liveD.lng)) ? Number(liveD.lng) : t.driverLng != null ? Number(t.driverLng) : null;
  let driver = null;
  if (dLat != null && dLng != null) {
    const targetLa = t.status === "IN_PROGRESS" ? Number(t.dropoffLat) : Number(t.pickupLat);
    const targetLo = t.status === "IN_PROGRESS" ? Number(t.dropoffLng) : Number(t.pickupLng);
    const dk = havKm(dLat, dLng, targetLa, targetLo);
    driver = { lat: dLat, lng: dLng, distanceKm: Math.round(dk * 10) / 10, etaMinutes: Math.max(1, Math.ceil(dk / 30 * 60)) };
  }
  const pin = user.sub === t.passengerId ? pinForTrip(t.id) : void 0;
  return c.json({ ...t, driver, ...pin ? { pin } : {} });
});
async function driverIdFor(sql, userId) {
  const r = await sql`SELECT id FROM drivers WHERE "userId" = ${userId} LIMIT 1`;
  return r[0]?.id;
}
var COMMISSION_RATE = 0.14;
var NEG_TRIP_LIMIT = 3;
function money(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}
async function applyCommission(sql, driverRowId, fare, tripId) {
  try {
    if (!driverRowId) return;
    const f = Number(fare || 0);
    if (!(f > 0)) return;
    const du = await sql`SELECT "userId" FROM drivers WHERE id = ${driverRowId} LIMIT 1`;
    const userId = du[0]?.userId;
    if (!userId) return;
    const u = await sql`SELECT "walletBalance", "negTrips" FROM users WHERE id = ${userId} LIMIT 1`;
    if (!u.length) return;
    const before = Number(u[0].walletBalance || 0);
    const commission = money(f * COMMISSION_RATE);
    const after = money(before - commission);
    let negTrips = Number(u[0].negTrips || 0);
    let blocked = 0;
    if (after < 0) {
      negTrips = negTrips + 1;
      if (negTrips >= NEG_TRIP_LIMIT) blocked = 1;
    } else {
      negTrips = 0;
    }
    await sql`UPDATE users SET "walletBalance" = ${after}, "negTrips" = ${negTrips}, "walletBlocked" = ${blocked}, "updatedAt" = NOW() WHERE id = ${userId}`;
    await sql`INSERT INTO wallet_tx (id, "userId", type, amount, "balanceAfter", "tripId", note, "createdAt") VALUES (gen_random_uuid()::text, ${userId}, 'COMMISSION', ${-commission}, ${after}, ${tripId}, ${"Comissao 14% da viagem"}, NOW())`;
    if (blocked) await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
  } catch (e) {
    console.error("commission error:", e);
  }
}
app.put("/api/v1/trips/:id/accept", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const id = c.req.param("id");
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: "S\xF3 motoristas." }, 403);
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== "REQUESTED") return c.json({ message: "Viagem indispon\xEDvel." }, 400);
  try {
    let t = cur[0];
    if (!t.offerBroadcast && (offerQueueOf(t).length || t.offeredDriverId)) {
      t = await advanceOfferIfNeeded(c.env, sql, t);
      if (!t.offerBroadcast && String(t.offeredDriverId || "") !== did) {
        return c.json({ message: "Esta oferta j\xE1 passou para outra motorista." }, 409);
      }
    }
  } catch {
  }
  const rows = await sql`UPDATE trips SET "driverId" = ${did}, status = 'ACCEPTED', "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'REQUESTED' RETURNING *`;
  if (!rows.length) return c.json({ message: "Viagem indispon\xEDvel." }, 400);
  pushStatus(c, id, "ACCEPTED");
  hubPoke(c);
  return c.json(rows[0]);
});
app.post("/api/v1/trips/:id/skip", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const id = c.req.param("id");
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: "S\xF3 motoristas." }, 403);
  try {
    const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
    if (!cur.length || cur[0].status !== "REQUESTED") return c.json({ ok: true });
    const t = cur[0];
    const skipped = offerSkippedOf(t);
    if (skipped.indexOf(did) < 0) skipped.push(did);
    if (!t.offerBroadcast && String(t.offeredDriverId || "") === did) {
      const q = offerQueueOf(t);
      const missed = offerMissedOf(t);
      const gone = (id2) => skipped.indexOf(id2) >= 0 || missed.indexOf(id2) >= 0;
      let idx = Number(t.offerIdx || 0) + 1;
      while (idx < q.length && gone(q[idx])) idx += 1;
      if (idx >= q.length) {
        const againS = q.filter((x) => skipped.indexOf(x) < 0);
        if (!againS.length) {
          await sql`UPDATE trips SET "offerBroadcast" = TRUE, "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
        } else {
          idx = q.indexOf(againS[0]);
          const expAtS = new Date(Date.now() + OFFER_TTL_SEC * 1e3);
          await sql`UPDATE trips SET "offerIdx" = ${idx}, "offeredDriverId" = ${q[idx]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAtS}, "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "offerMissed" = '[]'::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
          const rrS = await sql`SELECT "pickupAddress", "dropoffAddress", "fareEstimate" FROM trips WHERE id = ${id} LIMIT 1`;
          if (rrS.length) await pushTripToDriver(sql, q[idx], id, "\u{1F514} Novo pedido LadiesGo!", `${String(rrS[0].pickupAddress || "")} \u2192 ${String(rrS[0].dropoffAddress || "").split(" \xB7 ")[0]} \xB7 ${Number(rrS[0].fareEstimate || 0)} Kz`);
        }
      } else {
        const expAt = new Date(Date.now() + OFFER_TTL_SEC * 1e3);
        await sql`UPDATE trips SET "offerIdx" = ${idx}, "offeredDriverId" = ${q[idx]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAt}, "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
        const rr = await sql`SELECT "pickupAddress", "dropoffAddress", "fareEstimate" FROM trips WHERE id = ${id} LIMIT 1`;
        if (rr.length) await pushTripToDriver(sql, q[idx], id, "\u{1F514} Novo pedido LadiesGo!", `${String(rr[0].pickupAddress || "")} \u2192 ${String(rr[0].dropoffAddress || "").split(" \xB7 ")[0]} \xB7 ${Number(rr[0].fareEstimate || 0)} Kz`);
      }
    } else {
      await sql`UPDATE trips SET "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
    }
    hubPoke(c);
    return c.json({ ok: true });
  } catch (e) {
    console.error("skip error:", e);
    return c.json({ ok: true });
  }
});
app.put("/api/v1/trips/:id/arrived", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const rows = await sql`UPDATE trips SET status = 'DRIVER_ARRIVED', "arrivedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${c.req.param("id")} AND status = 'ACCEPTED' RETURNING *`;
  if (!rows.length) return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
  pushStatus(c, c.req.param("id"), "DRIVER_ARRIVED");
  try {
    c.executionCtx.waitUntil(pushPaxArrived(c.env, c.req.param("id")));
  } catch {
  }
  return c.json(rows[0]);
});
app.put("/api/v1/trips/:id/start", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const { pin } = await c.req.json().catch(() => ({}));
  const id = c.req.param("id");
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== "DRIVER_ARRIVED") return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
  if (String(pin || "") !== pinForTrip(id)) return c.json({ message: "C\xF3digo incorreto." }, 400);
  const rows = await sql`UPDATE trips SET status = 'IN_PROGRESS', "startedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'DRIVER_ARRIVED' RETURNING *`;
  if (!rows.length) return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
  pushStatus(c, id, "IN_PROGRESS");
  return c.json(rows[0]);
});
app.put("/api/v1/trips/:id/complete", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const id = c.req.param("id");
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== "IN_PROGRESS") return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
  const t = cur[0];
  const rows = await sql`UPDATE trips SET status = 'COMPLETED', "finalFare" = COALESCE("finalFare", "fareEstimate"), "completedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} RETURNING *`;
  if (t.driverId) await sql`UPDATE drivers SET "totalTrips" = "totalTrips" + 1, "totalEarnings" = "totalEarnings" + ${Number(t.finalFare || t.fareEstimate || 0) * 0.8} WHERE id = ${t.driverId}`;
  await applyCommission(sql, t.driverId, t.finalFare || t.fareEstimate, id);
  pushStatus(c, id, "COMPLETED");
  return c.json(rows[0]);
});
app.put("/api/v1/trips/:id/cancel", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const { reason } = await c.req.json().catch(() => ({}));
  const rows = await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = ${String(reason || "").slice(0, 80)}, "updatedAt" = NOW() WHERE id = ${c.req.param("id")} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') RETURNING *`;
  if (!rows.length) return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
  pushStatus(c, c.req.param("id"), "CANCELLED");
  hubPoke(c);
  return c.json(rows[0]);
});
app.post("/api/v1/ratings", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  try {
    let rated = String(b.ratedId || b.driverId || "");
    try {
      const tr = await sql`SELECT "passengerId", "driverId" FROM trips WHERE id = ${String(b.tripId)} LIMIT 1`;
      if (tr.length && !rated) {
        if (user.sub === tr[0].passengerId && tr[0].driverId) {
          const d = await sql`SELECT "userId" FROM drivers WHERE id = ${tr[0].driverId} LIMIT 1`;
          rated = d[0]?.userId || "";
        } else if (tr[0].passengerId) rated = tr[0].passengerId;
      }
    } catch {
    }
    await sql`INSERT INTO ratings (id, "tripId", "raterId", "ratedId", score, comment, "createdAt") VALUES (${String(b.tripId) + ":" + user.sub}, ${String(b.tripId)}, ${user.sub}, ${rated}, ${Number(b.score || 5)}, ${String(b.comment || "").slice(0, 500)}, NOW()) ON CONFLICT (id) DO NOTHING`;
  } catch (e) {
    console.error("ratings insert error:", e);
  }
  return c.json({ success: true });
});
app.get("/api/v1/notifications", requireAuth, async (c) => c.json({ notifications: [] }));
app.get("/api/v1/notifications/unread-count", requireAuth, async (c) => c.json({ count: 0 }));
app.put("/api/v1/notifications/read-all", requireAuth, async (c) => c.json({ success: true }));
app.post("/api/v1/payments/create-intent", requireAuth, async (c) => c.json({ clientSecret: null, cash: true }));
app.post("/api/v1/payments/confirm", requireAuth, async (c) => c.json({ success: true }));
var FALLBACK_ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  {
    urls: ["turn:openrelay.metered.ca:443?transport=tcp", "turns:openrelay.metered.ca:443"],
    username: "openrelay",
    credential: "openrelay"
  }
];
var PER_CALL_SEC = 120;
var MB_PER_MIN = 0.6;
var CALL_TYPES = ["offer", "answer", "ice", "reject", "end", "cancel"];
async function assertParticipant(sql, tripId, userId) {
  const rows = await sql`SELECT t.id FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${tripId} AND (t."passengerId" = ${userId} OR d."userId" = ${userId}) LIMIT 1`;
  return rows.length > 0;
}
async function turnQuota(sql, freeMb) {
  const budget = Math.floor((Number(freeMb) || 300) / MB_PER_MIN * 60);
  const agg = await sql`SELECT COALESCE(SUM("durationSec"), 0)::int AS used FROM call_logs WHERE "createdAt" >= date_trunc('month', NOW())`;
  const used = Number(agg[0]?.used || 0);
  const remaining = Math.max(0, budget - used);
  return { remainingSec: remaining, budgetSec: budget, usedSec: used, perCallSec: PER_CALL_SEC, exhausted: remaining <= 0 };
}
app.get("/api/v1/turn/ice", requireAuth, async (c) => {
  const domain = String(c.env.METERED_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const apiKey = String(c.env.METERED_TURN_APIKEY || "").trim();
  if (!domain || !apiKey) return c.json({ iceServers: FALLBACK_ICE, demo: true });
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8e3);
    const r = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (!r.ok || !Array.isArray(j)) throw new Error("metered");
    return c.json({ iceServers: j, demo: false });
  } catch {
    return c.json({ iceServers: FALLBACK_ICE, demo: true });
  }
});
app.get("/api/v1/turn/quota", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  return c.json(await turnQuota(sql, c.env.METERED_FREE_MB));
});
app.post("/api/v1/turn/log", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const { tripId, durationSec } = await c.req.json().catch(() => ({}));
  if (!tripId) return c.json({ message: "Viagem inv\xE1lida." }, 400);
  if (!await assertParticipant(sql, String(tripId), user.sub))
    return c.json({ message: "Sem acesso a esta viagem." }, 403);
  const dur = Math.min(3600, Math.max(0, Math.floor(Number(durationSec) || 0)));
  await sql`INSERT INTO call_logs (id, "tripId", "userId", "durationSec") VALUES (gen_random_uuid()::text, ${String(tripId)}, ${user.sub}, ${dur})`;
  return c.json(await turnQuota(sql, c.env.METERED_FREE_MB));
});
app.post("/api/v1/trips/:id/call/signal", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const id = c.req.param("id");
  const { type, payload } = await c.req.json().catch(() => ({}));
  if (!await assertParticipant(sql, id, user.sub))
    return c.json({ message: "Sem acesso a esta viagem." }, 403);
  if (CALL_TYPES.indexOf(String(type)) < 0) return c.json({ message: "Sinal inv\xE1lido." }, 400);
  const p = payload === void 0 || payload === null ? null : JSON.stringify(payload).slice(0, 4e3);
  const rows = await sql`INSERT INTO call_signals (id, "tripId", "senderId", type, payload) VALUES (gen_random_uuid()::text, ${id}, ${user.sub}, ${String(type)}, ${p}::json) RETURNING "createdAt"`;
  sql`DELETE FROM call_signals WHERE "tripId" = ${id} AND "createdAt" < NOW() - INTERVAL '10 minutes'`.catch(() => {
  });
  return c.json({ ok: true, ts: new Date(rows[0].createdAt).getTime() });
});
app.get("/api/v1/trips/:id/call/signal", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const id = c.req.param("id");
  if (!await assertParticipant(sql, id, user.sub))
    return c.json({ message: "Sem acesso a esta viagem." }, 403);
  const sinceMs = Number(c.req.query("since")) || 0;
  const cutoff = sinceMs > 0 ? sinceMs : Date.now() - 60 * 1e3;
  const rows = await sql`SELECT "senderId", type, payload, "createdAt" FROM call_signals WHERE "tripId" = ${id} AND "createdAt" > to_timestamp(${cutoff / 1e3}) ORDER BY "createdAt" ASC LIMIT 50`;
  return c.json({
    signals: rows.map((s) => ({
      from: s.senderId,
      type: s.type,
      payload: typeof s.payload === "string" ? JSON.parse(s.payload) : s.payload,
      ts: new Date(s.createdAt).getTime()
    })),
    now: Date.now()
  });
});
app.get("/api/v1/trips/:id/chat", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const id = c.req.param("id");
  if (!await assertParticipant(sql, id, user.sub))
    return c.json({ message: "Sem acesso a esta viagem." }, 403);
  const sinceMs = Number(c.req.query("since")) || 0;
  const rows = await sql`SELECT "senderName", text, "createdAt" FROM chat_messages WHERE "tripId" = ${id} AND "createdAt" > to_timestamp(${sinceMs / 1e3}) ORDER BY "createdAt" ASC LIMIT 50`;
  return c.json({
    msgs: rows.map((m) => ({ from: m.senderName || "?", text: m.text, ts: new Date(m.createdAt).getTime() }))
  });
});
app.post("/api/v1/trips/:id/chat", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const id = c.req.param("id");
  if (!await assertParticipant(sql, id, user.sub))
    return c.json({ message: "Sem acesso a esta viagem." }, 403);
  const { from, text } = await c.req.json().catch(() => ({}));
  const clean = String(text || "").trim().slice(0, 300);
  if (!clean) return c.json({ message: "Mensagem vazia." }, 400);
  await sql`INSERT INTO chat_messages (id, "tripId", "senderId", "senderName", text) VALUES (gen_random_uuid()::text, ${id}, ${user.sub}, ${String(from || "").slice(0, 40) || "Eu"}, ${clean})`;
  c.executionCtx.waitUntil((async () => {
    try {
      const t = await sql`SELECT "passengerId", "driverId" FROM trips WHERE id = ${id} LIMIT 1`;
      if (!t.length) return;
      let other = null;
      if (t[0].passengerId === user.sub && t[0].driverId) {
        const d = await sql`SELECT "userId" FROM drivers WHERE id = ${t[0].driverId} LIMIT 1`;
        other = d[0]?.userId || null;
      } else if (t[0].passengerId !== user.sub) {
        other = t[0].passengerId;
      }
      if (!other || other === user.sub) return;
      const u = await sql`SELECT "fcmToken" FROM users WHERE id = ${other} LIMIT 1`;
      const tok = u[0]?.fcmToken;
      if (!tok || String(tok).indexOf("ExponentPushToken") !== 0) return;
      await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ to: tok, sound: "default", title: "\u{1F4AC} Nova mensagem \u2014 LadiesGo!", body: clean.slice(0, 120), data: { tripId: id, type: "chat" } }]) });
    } catch {
    }
  })());
  return c.json({ ok: true });
});
function fold(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
function placeCat(t) {
  const b = String(t || "").split("[")[0].trim().toLowerCase();
  if (!b) return "Local";
  if (/^(12 portas|13 addr|kb-porta)/.test(b)) return "Morada";
  if (/^14 entradas/.test(b)) return "Edif\xEDcio";
  if (/^15 nos-nomeados/.test(b)) return "Local";
  if (/^10 condominios/.test(b)) return "Condom\xEDnio";
  if (/municipio/.test(b)) return "Munic\xEDpio";
  if (b === "yes") return "Local";
  if (/(neighbourhood|suburb|quarter|city_block)/.test(b)) return "Bairro";
  if (b === "apartment") return "Edif\xEDcio";
  if (b === "square") return "Pra\xE7a";
  if (/bureau_de_change/.test(b)) return "C\xE2mbio";
  if (/(restaurant|fast_food|bakery|food|cafe)/.test(b) || b === "bar") return "Restaurante";
  if (/(bank|atm)/.test(b)) return "Banco";
  if (/(car_parts|car_repair|tyres|fuel|motorcycle)/.test(b) || b === "car") return "Autom\xF3vel";
  if (/parking/.test(b)) return "Estacionamento";
  if (/(hairdresser|beauty|cosmetic)/.test(b)) return "Beleza";
  if (/(convenience|supermarket|kiosk|butcher|greengrocer|marketplace)/.test(b)) return "Mercado";
  if (/(clinic|pharmacy|hospital|dentist|doctor|health)/.test(b)) return "Sa\xFAde";
  if (/(clothes|shoes|furniture|electronics|mobile_phone|doityourself|jewel|hardware|florist|gift|optician)/.test(b)) return "Loja";
  if (/(school|college|university|educational|kindergarten|library)/.test(b)) return "Escola";
  if (/(place_of_worship|church|mosque)/.test(b)) return "Igreja";
  if (/(government|diplomatic|police|townhall|embassy|administrative)/.test(b)) return "Servi\xE7o p\xFAblico";
  if (/(hotel|hostel|guest|motel)/.test(b)) return "Hotel";
  if (/(taxi|bus_stop|bus_station|transport|aeroway|aerodrome)/.test(b)) return "Transporte";
  if (/(company|office|insurance|lawyer|consulting|logistics)/.test(b)) return "Empresa";
  if (/(residential|tertiary|secondary|trunk|primary|unclassified|service|motorway|living_street|pedestrian|road)/.test(b)) return "Rua";
  return b.charAt(0).toUpperCase() + b.slice(1);
}
async function localPlaces(c, q, lat, lng) {
  try {
    const sql = makeSql(c.env.DB);
    const tf = fold(q);
    const tk = tf.split(" ").filter((t) => t.length >= 2).slice(0, 3);
    const t1 = tk[0] || tf, t2 = tk[1] || "", t3 = tk[2] || "";
    let rows = [];
    try {
      const expr = tk.map((t) => t.replace(/[^\p{L}\p{N}]+/gu, "")).filter((t) => t.length >= 2).map((t) => t + "*").join(" ");
      if (expr) {
        rows = await sql`
          SELECT p.name, p.nname, p.lat, p.lng, p.type, p.municipality, p.province, p.street, p."number"
          FROM places_fts JOIN places p ON p.id = places_fts.rowid
          WHERE places_fts MATCH ${expr}
          ORDER BY (CASE WHEN p.name LIKE 'Bloco %' OR p.name LIKE 'Bloco%' OR p.name LIKE 'Quarteir%' THEN 1 ELSE 0 END) DESC,
            (ABS(p.lat - ${lat}) + ABS(p.lng - ${lng})) ASC
          LIMIT 400
        `;
      }
    } catch {
      rows = [];
    }
    if (rows.length < 8) {
      const g1 = t1.replace(/([*?\[\]])/g, "[$1]") + "*";
      rows = await sql`
        SELECT name, nname, lat, lng, type, municipality, province, street, "number"
        FROM places
        WHERE nname GLOB ${g1}
          AND (${t2} = '' OR norm LIKE ${"%" + t2 + "%"})
          AND (${t3} = '' OR norm LIKE ${"%" + t3 + "%"})
        ORDER BY (CASE WHEN name LIKE 'Bloco %' OR name LIKE 'Bloco%' OR name LIKE 'Quarteir%' THEN 1 ELSE 0 END) DESC,
          (ABS(lat - ${lat}) + ABS(lng - ${lng})) ASC
        LIMIT 400
      `;
      if (rows.length < 8) {
        rows = await sql`
          SELECT name, nname, lat, lng, type, municipality, province, street, "number"
          FROM places
          WHERE norm LIKE ${"%" + t1 + "%"}
            AND (${t2} = '' OR norm LIKE ${"%" + t2 + "%"})
            AND (${t3} = '' OR norm LIKE ${"%" + t3 + "%"})
          ORDER BY ((CASE WHEN nname LIKE ${tf + "%"} THEN 2 ELSE 0 END)
            + (CASE WHEN name LIKE 'Bloco %' OR name LIKE 'Bloco%' OR name LIKE 'Quarteir%' THEN 1 ELSE 0 END)) DESC,
            (ABS(lat - ${lat}) + ABS(lng - ${lng})) ASC
          LIMIT 400
        `;
      }
    }
    const out = rows.map((r) => {
      const type = String(r.type || "");
      const base = type.split("[")[0].trim();
      let name = String(r.name || "").trim();
      if (!name || name === base || name.startsWith(base) || /^\d+\s+(portas|addr)/i.test(name) || /^kb-porta/i.test(name)) {
        const st = String(r.street || "").trim(), num = String(r.number || "").trim();
        name = st && num ? `${st}, n\xBA ${num}` : st || (num ? `N\xBA ${num}` : "Morada");
      }
      return {
        name,
        lat: Number(r.lat),
        lng: Number(r.lng),
        cat: placeCat(type),
        municipality: String(r.municipality || ""),
        province: String(r.province || "Luanda"),
        street: String(r.street || ""),
        distanceKm: Math.round(havKm(lat, lng, Number(r.lat), Number(r.lng)) * 10) / 10,
        _p: String(r.nname || "").startsWith(tf) ? 1 : 0,
        _b: /^(bloco\b|quarteir)/i.test(String(r.name || "").trim()) ? 1 : 0
      };
    }).filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    out.sort((a, b) => b._p - a._p || b._b - a._b || a.distanceKm - b.distanceKm);
    const seen = /* @__PURE__ */ new Set();
    const dedup = out.filter((p) => {
      const k = p.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return dedup.slice(0, 15).map((p) => {
      delete p._p;
      delete p._b;
      return p;
    });
  } catch {
    return [];
  }
}
app.get("/api/places/search", async (c) => {
  const q = String(c.req.query("q") || "").trim();
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  if (q.length < 3 || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ places: [] }, 200, { "Cache-Control": "public, max-age=600" });
  }
  const pkey = "places:v12:" + q.toLowerCase() + ":" + Math.round(lat * 100) / 100 + "," + Math.round(lng * 100) / 100;
  const phit = await cacheGet(c, pkey);
  if (phit) return phit;
  const local = await localPlaces(c, q, lat, lng);
  if (local.length >= 1) return cachePut(c, pkey, 604800, { places: local });
  try {
    const photon = (async () => {
      try {
        const pr = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lng}&limit=20&lang=pt`, { signal: AbortSignal.timeout(8e3) });
        const pj = await pr.json();
        const feats = Array.isArray(pj?.features) ? pj.features : [];
        if (!feats.length) return null;
        const R = 6371, t = Math.PI / 180;
        const pplaces = feats.map((f) => {
          const co = f?.geometry?.coordinates || [];
          const plat = Number(co[1]), plng = Number(co[0]);
          const pp = f?.properties || {};
          const dLa = (plat - lat) * t, dLo = (plng - lng) * t;
          const s = Math.sin(dLa / 2) ** 2 + Math.cos(lat * t) * Math.cos(plat * t) * Math.sin(dLo / 2) ** 2;
          return { name: String(pp.name || q), lat: plat, lng: plng, cat: placeCat(String([pp.osm_key, pp.osm_value, pp.type].filter(Boolean).join("/"))), municipality: String(pp.city || pp.county || ""), province: String(pp.state || "Luanda"), distanceKm: Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10 };
        }).filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
        return pplaces.length ? pplaces : null;
      } catch {
        return null;
      }
    })();
    const nominatim = (async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=30&countrycodes=ao&viewbox=13.05,-8.70,13.55,-9.05&bounded=1&accept-language=pt&q=${encodeURIComponent(q)}`;
        const r = await fetch(url, { headers: { "User-Agent": "LadiesGo/1.0" }, signal: AbortSignal.timeout(8e3) });
        const j = await r.json();
        if (!Array.isArray(j)) return null;
        const places2 = j.map((p) => {
          const plat = Number(p.lat);
          const plng = Number(p.lon);
          const R = 6371, t = Math.PI / 180;
          const dLa = (plat - lat) * t, dLo = (plng - lng) * t;
          const s = Math.sin(dLa / 2) ** 2 + Math.cos(lat * t) * Math.cos(plat * t) * Math.sin(dLo / 2) ** 2;
          const distKm = 2 * R * Math.asin(Math.sqrt(s));
          return {
            name: String(p.display_name?.split(",").slice(0, 2).join(",") || p.display_name || q),
            lat: plat,
            lng: plng,
            cat: placeCat(String([p.class, p.type].filter(Boolean).join("/"))),
            municipality: "",
            province: "Luanda",
            distanceKm: Math.round(distKm * 10) / 10
          };
        }).filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
        return places2.length ? places2 : null;
      } catch {
        return null;
      }
    })();
    const places = await new Promise((resolve) => {
      let done = false, pend = 2;
      const take = (r) => {
        if (done) return;
        if (r && r.length) {
          done = true;
          resolve(r);
        } else if (--pend === 0) {
          done = true;
          resolve(null);
        }
      };
      photon.then(take, () => take(null));
      nominatim.then(take, () => take(null));
    });
    const ext = (places || []).filter((p) => !local.some((l) => l.name === p.name));
    return cachePut(c, pkey, 604800, { places: local.concat(ext).slice(0, 20) });
  } catch {
    return cachePut(c, pkey, 604800, { places: local });
  }
});
var LUANDA_ZONES = [
  ["Ingombota", -8.815, 13.231],
  ["Maianga", -8.86, 13.244],
  ["Rangel", -8.83, 13.256],
  ["Cazenga", -8.85, 13.292],
  ["Sambizanga", -8.822, 13.27],
  ["Samba", -8.873, 13.2],
  ["Viana", -8.903, 13.374],
  ["Cacuaco", -8.783, 13.375],
  ["Belas", -8.95, 13.2],
  ["Talatona", -8.92, 13.181],
  ["Kilamba Kiaxi", -8.901, 13.234],
  ["Icolo e Bengo", -9.07, 13.52],
  ["Benfica", -8.94, 13.165],
  ["Sequele", -8.888, 13.488]
];
function offlineZone(la, lo) {
  let best = "", bd = 60;
  for (const [n, zla, zlo] of LUANDA_ZONES) {
    const d = havKm(la, lo, zla, zlo);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}
async function cacheGet(c, key) {
  try {
    const hit = await caches.default.match(new Request("https://cache.local/" + key));
    return hit || null;
  } catch {
    return null;
  }
}
async function cachePut(c, key, ttlSec, obj) {
  const res = c.json(obj, 200, { "Cache-Control": `public, max-age=${ttlSec}` });
  try {
    c.executionCtx.waitUntil(caches.default.put(new Request("https://cache.local/" + key), res.clone()));
  } catch {
  }
  return res;
}
app.get("/api/zone", async (c) => {
  const la = Number(c.req.query("lat")), lo = Number(c.req.query("lng"));
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: "Pedido inv\xE1lido." }, 400);
  const zkey = "zone:" + Math.round(la * 1e4) / 1e4 + "," + Math.round(lo * 1e4) / 1e4;
  const zhit = await cacheGet(c, zkey);
  if (zhit) return zhit;
  let zone = "";
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${la}&lon=${lo}&format=json&zoom=14`, { headers: { "User-Agent": "LadiesGo/1.0" }, signal: AbortSignal.timeout(8e3) });
    const j = await r.json();
    const a = j?.address || {};
    zone = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || "";
  } catch {
  }
  if (!zone) zone = offlineZone(la, lo);
  return cachePut(c, zkey, 2592e3, { zone });
});
app.get("/api/route", async (c) => {
  const from = String(c.req.query("from") || "").split(",").map(Number);
  const to = String(c.req.query("to") || "").split(",").map(Number);
  if (from.length !== 2 || to.length !== 2 || ![...from, ...to].every(Number.isFinite)) return c.json({ message: "Pedido inv\xE1lido." }, 400);
  const qf = (n) => Math.round(n * 1e3) / 1e3;
  const rkey = "route:" + qf(from[0]) + "," + qf(from[1]) + "|" + qf(to[0]) + "," + qf(to[1]);
  const rhit = await cacheGet(c, rkey);
  if (rhit) return rhit;
  try {
    const q = `${qf(from[1])},${qf(from[0])};${qf(to[1])},${qf(to[0])}?overview=full&geometries=geojson`;
    const vq = encodeURIComponent(JSON.stringify({
      locations: [{ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }],
      costing: "auto",
      format: "osrm",
      shape_format: "geojson",
      directions_type: "none"
    }));
    const bases = [
      "https://router.project-osrm.org/route/v1/driving/" + q,
      "https://routing.openstreetmap.de/routed-car/route/v1/driving/" + q,
      "https://valhalla1.openstreetmap.de/route?json=" + vq
    ];
    for (const base of bases) {
      try {
        const r = await fetch(base, { headers: { "User-Agent": "LadiesGo/1.0" }, signal: AbortSignal.timeout(4e3) });
        const j = await r.json();
        const g = j?.routes?.[0]?.geometry?.coordinates;
        if (g?.length) return cachePut(c, rkey, 3600, { points: g.map((p) => [p[1], p[0]]), distance_m: j.routes[0].distance, duration_s: j.routes[0].duration });
      } catch {
      }
    }
    return c.json({ message: "Sem rota de momento." }, 502);
  } catch {
    return c.json({ message: "Sem rota de momento." }, 502);
  }
});
function requireAdmin(c, next) {
  if (!c.get("user") || c.get("user").role !== "ADMIN") {
    return c.json({ message: "Acesso negado." }, 403);
  }
  return next();
}
function adminMiddleware(c, next) {
  return requireAuth(c, () => requireAdmin(c, next));
}
app.get("/api/v1/admin/stats", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const [driversRes, tripsRes, usersRes, revenueRes] = await Promise.all([
    sql`SELECT COUNT(*)::int AS total FROM drivers WHERE status = 'APPROVED' AND "isOnline" = true`,
    sql`SELECT status, COUNT(*)::int AS count FROM trips GROUP BY status`,
    sql`SELECT COUNT(*)::int AS total FROM users WHERE "isActive" = true`,
    sql`SELECT COALESCE(SUM("finalFare"), 0)::numeric AS total FROM trips WHERE status = 'COMPLETED'`
  ]);
  const byStatus = {};
  for (const r of tripsRes) byStatus[r.status] = Number(r.count);
  return c.json({
    driversOnline: Number(driversRes[0]?.total || 0),
    trips: byStatus,
    activeDrivers: Number(driversRes[0]?.total || 0),
    totalUsers: Number(usersRes[0]?.total || 0),
    revenueKz: Number(revenueRes[0]?.total || 0),
    total: Number(tripsRes.reduce((s, r) => s + Number(r.count), 0))
  });
});
app.get("/api/v1/admin/trips", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const status = c.req.query("status");
  const passengerId = c.req.query("passengerId");
  const offset = (page - 1) * limit;
  try {
    if (passengerId && !status) {
      const pTotal = await sql`SELECT COUNT(*)::int AS total FROM trips WHERE "passengerId" = ${passengerId}`;
      const pRows = await sql`
        SELECT t.*,
          u.name AS passenger_name, u.phone AS passenger_phone,
          du.name AS driver_name, du.phone AS driver_phone, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
        FROM trips t
        LEFT JOIN users u ON u.id = t."passengerId"
        LEFT JOIN drivers d ON d.id = t."driverId"
        LEFT JOIN users du ON du.id = d."userId"
        WHERE t."passengerId" = ${passengerId}
        ORDER BY t."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return c.json({ trips: pRows, total: Number(pTotal[0]?.total || 0) });
    }
    if (status) {
      const isActive = status === "ACTIVE";
      const totalRes = isActive ? await sql`SELECT COUNT(*)::int AS total FROM trips WHERE status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')` : await sql`SELECT COUNT(*)::int AS total FROM trips WHERE status = ${status}`;
      const tripsRes = isActive ? await sql`
        SELECT t.*, 
          u.name AS passenger_name, u.phone AS passenger_phone,
          du.name AS driver_name, du.phone AS driver_phone, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
        FROM trips t
        LEFT JOIN users u ON u.id = t."passengerId"
        LEFT JOIN drivers d ON d.id = t."driverId"
        LEFT JOIN users du ON du.id = d."userId"
        WHERE t.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')
        ORDER BY t."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      ` : await sql`
        SELECT t.*, 
          u.name AS passenger_name, u.phone AS passenger_phone,
          du.name AS driver_name, du.phone AS driver_phone, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
        FROM trips t
        LEFT JOIN users u ON u.id = t."passengerId"
        LEFT JOIN drivers d ON d.id = t."driverId"
        LEFT JOIN users du ON du.id = d."userId"
        WHERE t.status = ${status}
        ORDER BY t."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const trips = tripsRes.map((r) => ({
        id: r.id,
        passenger: r.passenger_name,
        passengerId: r.passengerId,
        from: r.pickupAddress,
        to: r.dropoffAddress,
        cat: r.rideType,
        fare: r.finalFare != null ? Number(r.finalFare) : Number(r.fareEstimate),
        status: r.status,
        by: r.cancelledBy,
        reason: r.cancelReason,
        driver: r.driver_name,
        driverId: r.driverId,
        passengerPhone: r.passenger_phone || "",
        driverPhone: r.driver_phone || "",
        vehicle: [r.car_make, r.car_model, r.car_plate].filter(Boolean).join(" \xB7 "),
        pickupLat: r.pickupLat,
        pickupLng: r.pickupLng,
        dropoffLat: r.dropoffLat,
        dropoffLng: r.dropoffLng,
        stops: r.stops || [],
        ts: r.createdAt
      }));
      return c.json({ trips, total: Number(totalRes[0]?.total || 0) });
    } else {
      const totalRes = await sql`SELECT COUNT(*)::int AS total FROM trips`;
      const tripsRes = await sql`
        SELECT t.*, 
          u.name AS passenger_name, u.phone AS passenger_phone,
          du.name AS driver_name, du.phone AS driver_phone, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
        FROM trips t
        LEFT JOIN users u ON u.id = t."passengerId"
        LEFT JOIN drivers d ON d.id = t."driverId"
        LEFT JOIN users du ON du.id = d."userId"
        ORDER BY t."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const trips = tripsRes.map((r) => ({
        id: r.id,
        passenger: r.passenger_name,
        passengerId: r.passengerId,
        from: r.pickupAddress,
        to: r.dropoffAddress,
        cat: r.rideType,
        fare: r.finalFare != null ? Number(r.finalFare) : Number(r.fareEstimate),
        status: r.status,
        by: r.cancelledBy,
        reason: r.cancelReason,
        driver: r.driver_name,
        driverId: r.driverId,
        passengerPhone: r.passenger_phone || "",
        driverPhone: r.driver_phone || "",
        vehicle: [r.car_make, r.car_model, r.car_plate].filter(Boolean).join(" \xB7 "),
        pickupLat: r.pickupLat,
        pickupLng: r.pickupLng,
        dropoffLat: r.dropoffLat,
        dropoffLng: r.dropoffLng,
        stops: r.stops || [],
        ts: r.createdAt
      }));
      return c.json({ trips, total: Number(totalRes[0]?.total || 0) });
    }
  } catch (e) {
    console.error("Admin trips error:", e);
    return c.json({ message: "Erro ao buscar viagens" }, 500);
  }
});
app.get("/api/v1/admin/driver-stats", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  try {
    const rows = await sql`
      SELECT t."driverId", COUNT(*)::int AS total,
        SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END)::int AS completed,
        SUM(CASE WHEN t.status = 'CANCELLED' THEN 1 ELSE 0 END)::int AS cancelled,
        COALESCE(SUM(CASE WHEN t.status = 'COMPLETED' THEN COALESCE(t."finalFare", t."fareEstimate", 0) ELSE 0 END), 0)::int AS revenue,
        MAX(du.name) AS name
      FROM trips t
      LEFT JOIN drivers d ON d.id = t."driverId"
      LEFT JOIN users du ON du.id = d."userId"
      WHERE t."driverId" IS NOT NULL
      GROUP BY t."driverId"
      ORDER BY total DESC`;
    return c.json({ driverStats: rows.map((r) => ({ driverId: r.driverId, name: r.name || "", total: Number(r.total || 0), completed: Number(r.completed || 0), cancelled: Number(r.cancelled || 0), revenue: Number(r.revenue || 0) })) });
  } catch (e) {
    console.error("Admin driver-stats error:", e);
    return c.json({ driverStats: [] });
  }
});
app.get("/api/v1/admin/drivers", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const driversRes = await sql`
    SELECT d.*, u.name, u.phone, u."profilePhoto", u."isActive" AS "userActive"
    FROM drivers d
    JOIN users u ON u.id = d."userId"
    WHERE d.status = 'APPROVED'
    ORDER BY d."createdAt" DESC
  `;
  return c.json({ drivers: driversRes });
});
app.get("/api/v1/admin/users", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const role = c.req.query("role");
  const q = c.req.query("q");
  const offset = (page - 1) * limit;
  const like = q ? `%${q}%` : null;
  try {
    let totalRes, usersRes;
    if (role && like) {
      totalRes = await sql`SELECT COUNT(*)::int AS total FROM users u WHERE u."isActive" = true AND u.role = ${role} AND (u.name ILIKE ${like} OR u.phone ILIKE ${like})`;
      usersRes = await sql`
      SELECT u.id, u.name, u.phone, u.role, u."profilePhoto", u."isVerified", u."createdAt",
        d.status AS driver_status, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
      FROM users u
      LEFT JOIN drivers d ON d."userId" = u.id
      WHERE u."isActive" = true AND u.role = ${role} AND (u.name ILIKE ${like} OR u.phone ILIKE ${like})
        ORDER BY u."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}`;
    } else if (role) {
      totalRes = await sql`SELECT COUNT(*)::int AS total FROM users u WHERE u."isActive" = true AND u.role = ${role}`;
      usersRes = await sql`
      SELECT u.id, u.name, u.phone, u.role, u."profilePhoto", u."isVerified", u."createdAt",
        d.status AS driver_status, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
      FROM users u
      LEFT JOIN drivers d ON d."userId" = u.id
      WHERE u."isActive" = true AND u.role = ${role}
        ORDER BY u."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}`;
    } else if (like) {
      totalRes = await sql`SELECT COUNT(*)::int AS total FROM users u WHERE u."isActive" = true AND (u.name ILIKE ${like} OR u.phone ILIKE ${like})`;
      usersRes = await sql`
      SELECT u.id, u.name, u.phone, u.role, u."profilePhoto", u."isVerified", u."createdAt",
        d.status AS driver_status, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
      FROM users u
      LEFT JOIN drivers d ON d."userId" = u.id
      WHERE u."isActive" = true AND (u.name ILIKE ${like} OR u.phone ILIKE ${like})
        ORDER BY u."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}`;
    } else {
      totalRes = await sql`SELECT COUNT(*)::int AS total FROM users u WHERE u."isActive" = true`;
      usersRes = await sql`
      SELECT u.id, u.name, u.phone, u.role, u."profilePhoto", u."isVerified", u."createdAt",
        d.status AS driver_status, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
      FROM users u
      LEFT JOIN drivers d ON d."userId" = u.id
      WHERE u."isActive" = true
      ORDER BY u."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}`;
    }
    const total = Number(totalRes[0]?.total || 0);
    return c.json({ users: usersRes, total });
  } catch (e) {
    console.error("Admin users error:", e);
    return c.json({ message: "Erro ao buscar utilizadores", error: String(e) }, 500);
  }
});
app.post("/api/v1/admin/users/:id/reset-password", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const { id } = c.req.param();
  const resetHash = await hashPassword("0987654321");
  const rows = await sql`
    UPDATE users SET "passwordHash" = ${resetHash},
      "mustChangePassword" = true, "isActive" = true, "updatedAt" = NOW()
    WHERE id = ${id} RETURNING id`;
  if (!rows.length) return c.json({ message: "Utilizador n\xE3o encontrado." }, 404);
  return c.json({ success: true, reactivated: true });
});
app.post("/api/v1/admin/wallet/credit", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const b = await c.req.json().catch(() => ({}));
  const dg = String(b?.phone || "").replace(/\D/g, "");
  const local = dg.indexOf("244") === 0 ? dg.slice(3) : dg;
  const amount = Number(b?.amount);
  if (!/^9[123459]\d{7}$/.test(local)) return c.json({ message: "N\xFAmero angolano inv\xE1lido: 9XX XXX XXX." }, 400);
  if (!(amount > 0)) return c.json({ message: "Valor inv\xE1lido." }, 400);
  const rows = await sql`SELECT id, name, phone, role, "walletBalance", "negTrips", "walletBlocked" FROM users WHERE phone = ${"+244" + local} AND "isActive" = true LIMIT 1`;
  if (!rows.length) return c.json({ message: "Conta n\xE3o encontrada." }, 404);
  const u = rows[0];
  if (String(u.role) !== "DRIVER") return c.json({ message: "Esta conta n\xE3o \xE9 de motorista." }, 400);
  const before = money(u.walletBalance);
  const after = money(before + amount);
  const blocked = after < 0 ? 1 : 0;
  const negTrips = after < 0 ? Number(u.negTrips || 0) : 0;
  const admin = c.get("user");
  await sql`UPDATE users SET "walletBalance" = ${after}, "negTrips" = ${negTrips}, "walletBlocked" = ${blocked}, "updatedAt" = NOW() WHERE id = ${u.id}`;
  await sql`INSERT INTO wallet_tx (id, "userId", type, amount, "balanceAfter", note, "createdAt") VALUES (gen_random_uuid()::text, ${u.id}, 'TOPUP', ${money(amount)}, ${after}, ${"Carregamento admin " + String(admin?.sub || "")}, NOW())`;
  return c.json({ ok: true, user: { id: u.id, name: u.name, phone: u.phone }, before, after, blocked: !!blocked, negTrips });
});
app.get("/api/v1/admin/wallet", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const q = String(c.req.query("q") || "").replace(/\D/g, "");
  const rows = q ? await sql`SELECT id, name, phone, "walletBalance", "negTrips", "walletBlocked" FROM users WHERE role = 'DRIVER' AND phone LIKE ${"%" + q} ORDER BY "walletBalance" ASC LIMIT 100` : await sql`SELECT id, name, phone, "walletBalance", "negTrips", "walletBlocked" FROM users WHERE role = 'DRIVER' ORDER BY "walletBalance" ASC LIMIT 100`;
  return c.json({ wallets: rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, balance: money(r.walletBalance), negTrips: Number(r.negTrips || 0), blocked: !!Number(r.walletBlocked || 0) })) });
});
async function tgSendPhoto(env, dataUrl, caption) {
  try {
    const tok = String(env?.TG_BOT_TOKEN || env?.TELEGRAM_BOT_TOKEN || "");
    const chat = String(env?.TG_CHAT_ID || env?.TELEGRAM_CHAT_ID || "");
    if (!tok || !chat) return false;
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ""));
    if (!m) return false;
    const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    const fd = new FormData();
    fd.append("chat_id", chat);
    if (caption) fd.append("caption", caption.slice(0, 1e3));
    fd.append("photo", new Blob([bin], { type: m[1] }), "foto.jpg");
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendPhoto`, { method: "POST", body: fd, signal: AbortSignal.timeout(15e3) });
    return r.ok;
  } catch {
    return false;
  }
}
app.put("/api/v1/admin/users/:id/photo", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  const photo = String(b.photo || "");
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photo)) return c.json({ message: "Foto invalida." }, 400);
  if (photo.length > 2 * 1024 * 1024) return c.json({ message: "Foto demasiado grande." }, 413);
  const rows = await sql`UPDATE users SET "profilePhoto" = ${photo}, "updatedAt" = NOW() WHERE id = ${id} RETURNING id, name, phone, role`;
  if (!rows.length) return c.json({ message: "Utilizador nao encontrado." }, 404);
  const u = rows[0];
  const tgOn = !!((c.env.TG_BOT_TOKEN || c.env.TELEGRAM_BOT_TOKEN) && (c.env.TG_CHAT_ID || c.env.TELEGRAM_CHAT_ID));
  if (tgOn) {
    const caption = `LadiesGo \xB7 foto de ${u.name || u.phone || ""} (${u.role || ""})`;
    try {
      c.executionCtx.waitUntil(tgSendPhoto(c.env, photo, caption).catch(() => false));
    } catch {
      tgSendPhoto(c.env, photo, caption).catch(() => false);
    }
  }
  return c.json({ success: true, telegram: tgOn });
});
app.get("/api/v1/admin/drivers/pending", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const pendingRes = await sql`
    SELECT d.*, u.name, u.phone
    FROM drivers d
    JOIN users u ON u.id = d."userId"
    WHERE d.status = 'PENDING'
    ORDER BY d."createdAt" DESC
  `;
  return c.json(pendingRes);
});
app.put("/api/v1/admin/drivers/:id/approve", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const { id } = c.req.param();
  await sql`UPDATE drivers SET status = 'APPROVED', "updatedAt" = NOW() WHERE id = ${id}`;
  return c.json({ success: true });
});
app.put("/api/v1/admin/drivers/:id/reject", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const { id } = c.req.param();
  await sql`UPDATE drivers SET status = 'REJECTED', "isOnline" = false, "updatedAt" = NOW() WHERE id = ${id}`;
  return c.json({ success: true });
});
app.post("/api/v1/admin/drivers/create", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const { phone, name, licenseNumber, carPlate, carMake, carModel, carYear, carColor } = await c.req.json().catch(() => ({}));
  if (!phone || !name) return c.json({ message: "Nome e n\xFAmero obrigat\xF3rios." }, 400);
  const cleanPhone = phone.startsWith("+244") ? phone : `+244${phone.replace(/\D/g, "")}`;
  const exists = await sql`SELECT id FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
  if (exists.length) return c.json({ message: "N\xFAmero j\xE1 registado." }, 409);
  const userRes = await sql`INSERT INTO users (id, phone, "passwordHash", name, role, "isVerified", "updatedAt") VALUES (gen_random_uuid()::text, ${cleanPhone}, ${await hashPassword("0987654321")}, ${name}, 'DRIVER', true, NOW()) RETURNING id`;
  const userId = userRes[0].id;
  const driverStatus = "APPROVED";
  await sql`
    INSERT INTO drivers (id, "userId", "licenseNumber", "carPlate", "carMake", "carModel", "carYear", "carColor", status, "updatedAt")
    VALUES (gen_random_uuid()::text, ${userId}, ${licenseNumber || null}, ${carPlate || null}, ${carMake || null}, ${carModel || null}, ${carYear || null}, ${carColor || null}, ${driverStatus}, NOW())
  `;
  return c.json({ success: true, userId, driverStatus, password: "0987654321" });
});
app.get("/api/v1/categories", async (c) => {
  try {
    const sql = makeSql(c.env.DB);
    return c.json({ categories: await getCategories(sql) });
  } catch {
    return c.json({ categories: [
      { code: "ECONOMY", name: "Econ\xF3mico", color: "#61188E", mult: 1 },
      { code: "COMFORT", name: "Conforto", color: "#ff5fc8", mult: 1.4 },
      { code: "PREMIUM", name: "Fam\xEDlia", color: "#5b21c9", mult: 1.65 }
    ] });
  }
});
app.post("/api/v1/admin/categories", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name || "").trim().slice(0, 30);
  const color = String(b.color || "").trim();
  const mult = Number(b.mult);
  if (name.length < 2 || !/^#[0-9a-fA-F]{6}$/.test(color) || !Number.isFinite(mult) || mult < 0.5 || mult > 5) {
    return c.json({ message: "Dados inv\xE1lidos (nome 2-30, cor #hex, mult 0.5-5)." }, 400);
  }
  const code = name.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 16) || "CAT";
  try {
    await getCategories(sql);
    bustCatCache();
    const rows = await sql`INSERT INTO ride_categories (code, name, color, mult, sort) VALUES (${code}, ${name}, ${color}, ${mult}, 99) RETURNING code, name, color, mult`;
    const r = rows[0];
    return c.json({ category: { code: r.code, name: r.name, color: r.color, mult: Number(r.mult) } });
  } catch (e) {
    if (String(e).includes("duplicate") || String(e).includes("already exists")) return c.json({ message: "J\xE1 existe categoria com esse nome." }, 409);
    console.error("add category error:", e);
    return c.json({ message: "Falhou ao criar." }, 500);
  }
});
app.put("/api/v1/admin/categories/:code", adminMiddleware, async (c) => {
  const sql = makeSql(c.env.DB);
  const code = String(c.req.param("code") || "").toUpperCase().slice(0, 16);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name || "").trim().slice(0, 30);
  const color = String(b.color || "").trim();
  const mult = Number(b.mult);
  if (!code || name.length < 2 || !/^#[0-9a-fA-F]{6}$/.test(color) || !Number.isFinite(mult) || mult < 0.5 || mult > 5) {
    return c.json({ message: "Dados inv\xE1lidos (nome 2-30, cor #hex, mult 0.5-5)." }, 400);
  }
  await getCategories(sql);
  bustCatCache();
  const rows = await sql`UPDATE ride_categories SET name = ${name}, color = ${color}, mult = ${mult} WHERE code = ${code} RETURNING code, name, color, mult`;
  if (!rows.length) return c.json({ message: "Categoria n\xE3o encontrada." }, 404);
  const r = rows[0];
  return c.json({ category: { code: r.code, name: r.name, color: r.color, mult: Number(r.mult) } });
});
var WEB2NEON = { pending: "REQUESTED", accepted: "ACCEPTED", arrived: "DRIVER_ARRIVED", in_progress: "IN_PROGRESS", completed: "COMPLETED", cancelled: "CANCELLED" };
var NEON2WEB = { REQUESTED: "pending", ACCEPTED: "accepted", DRIVER_ARRIVED: "arrived", IN_PROGRESS: "in_progress", COMPLETED: "completed", CANCELLED: "cancelled" };
var RIDE2CAT = { ECONOMY: "Econ\xF3mico", COMFORT: "Conforto", PREMIUM: "Fam\xEDlia" };
function pay2method(p) {
  return /card|tpa|multicaixa|visa|master/i.test(String(p || "")) ? "CARD" : "CASH";
}
var paxLive = /* @__PURE__ */ new Map();
function webTripRow(r, drv, paxName, catName, paxPhone, paxPhoto) {
  const addr = String(r.dropoffAddress || "Luanda");
  const cut = addr.indexOf(" \xB7 ");
  const destN = cut >= 0 ? addr.slice(0, cut) : addr;
  const destA = cut >= 0 ? addr.slice(cut + 3) : "";
  const stops = Array.isArray(r.stops) ? r.stops : [];
  const cat = catName ? catName(r.rideType) : RIDE2CAT[r.rideType] || "Econ\xF3mico";
  return {
    id: r.id,
    status: NEON2WEB[r.status] || r.status,
    passengerId: r.passengerId,
    passengerName: paxName || r.passengerName || "Passageira",
    passengerPhone: paxPhone || r.passengerPhone || "",
    passengerPhoto: paxPhoto || r.passengerPhoto || "",
    pickup: { lat: Number(r.pickupLat), lng: Number(r.pickupLng), name: String(r.pickupAddress || "Ponto no mapa") },
    dest: { n: destN, a: destA, lat: Number(r.dropoffLat), lng: Number(r.dropoffLng) },
    stops: stops.map((s) => ({ n: String(s.n || ""), a: String(s.a || ""), lat: Number(s.lat), lng: Number(s.lng) })),
    fare: r.finalFare != null ? Number(r.finalFare) : Number(r.fareEstimate),
    cat,
    pay: r.paymentMethod === "CARD" ? "Cart\xE3o" : "Numer\xE1rio",
    driver: drv || null,
    pin: pinForTrip(r.id),
    views: 0,
    offerExpiresAt: r.offerExpiresAt ? new Date(r.offerExpiresAt).getTime() : 0,
    serverNow: Date.now(),
    offerIndex: offerQueueOf(r).length ? Number(r.offerIdx || 0) + 1 : 0,
    offerTotal: offerQueueOf(r).length,
    isBroadcast: !r.offeredDriverId && !offerQueueOf(r).length ? true : !!r.offerBroadcast,
    ts: r.createdAt,
    by: r.cancelledBy || "",
    reason: r.cancelReason || "",
    scheduledAt: r.scheduledAt ? new Date(r.scheduledAt).getTime() : 0,
    completedAt: r.completedAt ? new Date(r.completedAt).getTime() : 0,
    arrivedAt: r.arrivedAt ? new Date(r.arrivedAt).getTime() : 0,
    startedAt: r.startedAt ? new Date(r.startedAt).getTime() : 0
  };
}
async function webDriverInfo(env, sql, driverId) {
  if (!driverId) return null;
  const d = await sql`
    SELECT d."userId", d."currentLat", d."currentLng", d.rating, d."totalTrips", d."carMake", d."carModel", d."carColor", d."carPlate", u.name, u.phone, u."profilePhoto"
    FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${driverId} LIMIT 1`;
  if (!d.length) return null;
  const r = d[0];
  const live = await geoGet(env, String(r.userId || ""));
  const lat = live && Number.isFinite(Number(live.lat)) ? Number(live.lat) : r.currentLat != null ? Number(r.currentLat) : null;
  const lng = live && Number.isFinite(Number(live.lng)) ? Number(live.lng) : r.currentLng != null ? Number(r.currentLng) : null;
  let avg = r.rating != null ? Number(r.rating) : 5;
  try {
    const ar = await sql`SELECT COALESCE(AVG(rt.score), 0)::float AS a, COUNT(*)::int AS n FROM ratings rt JOIN trips t ON t.id = rt."tripId" WHERE t."driverId" = ${driverId}`;
    if (ar[0] && Number(ar[0].n) > 0) avg = Math.round(Number(ar[0].a) * 10) / 10;
  } catch {
  }
  return {
    lat,
    lng,
    name: r.name || "Motorista",
    phone: r.phone || "",
    photo: r.profilePhoto || "",
    rating: avg,
    totalTrips: Number(r.totalTrips || 0),
    carMake: r.carMake || "",
    carModel: r.carModel || "",
    carColor: r.carColor || "",
    carPlate: r.carPlate || ""
  };
}
var OFFER_TTL_SEC = 30;
var OFFER_MAX = 15;
var OFFER_RADIUS_STEPS = [
  { after: 0, km: 5 },
  { after: 28, km: 8 },
  { after: 58, km: 12 }
];
function offerRadiusKm(createdAt) {
  const t0 = createdAt ? new Date(createdAt).getTime() : 0;
  const el = t0 ? (Date.now() - t0) / 1e3 : 0;
  let km = OFFER_RADIUS_STEPS[0].km;
  for (const s of OFFER_RADIUS_STEPS) if (el >= s.after) km = s.km;
  return km;
}
function offerQueueOf(t) {
  const q = t.offerQueue;
  return Array.isArray(q) ? q.map((x) => String(x)).filter(Boolean) : [];
}
function offerSkippedOf(t) {
  const s = t.offerSkipped;
  return Array.isArray(s) ? s.map((x) => String(x)).filter(Boolean) : [];
}
function offerMissedOf(t) {
  const s = t.offerMissed;
  return Array.isArray(s) ? s.map((x) => String(x)).filter(Boolean) : [];
}
async function buildOfferQueue(env, sql, pLa, pLo, rideCode, radiusKm = 5, limit = OFFER_MAX) {
  let byCode = {};
  try {
    byCode = (await catMaps(sql)).byCode;
  } catch {
  }
  const pos = await geoAll(env);
  const hasPickup = Number.isFinite(pLa) && Number.isFinite(pLo);
  const cands = [];
  for (const p of pos) {
    if (!p || !p.userId) continue;
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const km = hasPickup ? havKm(pLa, pLo, lat, lng) : 0;
    if (Number.isFinite(km) && km <= radiusKm) cands.push({ userId: String(p.userId), km, stale: Date.now() - Number(p.ts || 0) });
  }
  if (!cands.length) return [];
  cands.sort((a, b) => a.km - b.km || a.stale - b.stale);
  const candLimit = Math.min(cands.length, Math.max(limit * 4, 40));
  const ids = cands.slice(0, candLimit).map((c) => c.userId);
  const kmByUser = new Map(cands.map((c) => [c.userId, c.km]));
  let rows = [];
  try {
    const P = 'SELECT d.id, d."userId", d.cats FROM drivers d WHERE d."userId" IN (';
    const S = `) AND d."isOnline" = true AND d.status = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS'))`;
    const strings = [P, ...Array(Math.max(0, ids.length - 1)).fill(", "), S];
    rows = await sql(strings, ...ids);
  } catch {
    return [];
  }
  const wantCat = byCode[rideCode] || "";
  return rows.map((d) => {
    if (Array.isArray(d.cats) && d.cats.length && wantCat && d.cats.map((x) => String(x)).indexOf(wantCat) < 0) return null;
    const km = kmByUser.has(String(d.userId)) ? kmByUser.get(String(d.userId)) : radiusKm;
    return { id: String(d.id), km };
  }).filter((d) => d).sort((a, b) => a.km - b.km).slice(0, limit).map((d) => d.id);
}
async function pushTripToDriver(sql, driverId, tripId, title, body) {
  try {
    const r = await sql`SELECT u."fcmToken" FROM drivers d JOIN users u ON u.id = d."userId" WHERE d.id = ${driverId} AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')) LIMIT 1`;
    const tok = r[0]?.fcmToken;
    if (!tok || String(tok).indexOf("ExponentPushToken") !== 0) return;
    await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ to: tok, sound: "default", title, body, data: { tripId, type: "new-trip" } }]) });
  } catch {
  }
}
async function advanceOfferIfNeeded(env, sql, t, pushBody) {
  try {
    if (!t || t.status !== "REQUESTED" || t.offerBroadcast) return t;
    const exp = t.offerExpiresAt ? new Date(t.offerExpiresAt).getTime() : 0;
    if (exp && Date.now() < exp) return t;
    const q = offerQueueOf(t);
    const skipped = offerSkippedOf(t);
    const missed = offerMissedOf(t);
    const cur = t.offeredDriverId ? String(t.offeredDriverId) : "";
    const wantKm = offerRadiusKm(t.createdAt);
    if (wantKm > 5) {
      try {
        const known = /* @__PURE__ */ new Set([...q, ...skipped, ...missed]);
        const cand = await buildOfferQueue(env, sql, Number(t.pickupLat), Number(t.pickupLng), String(t.rideType || "ECONOMY"), wantKm, OFFER_MAX);
        for (const id of cand) if (!known.has(id)) {
          q.push(id);
          known.add(id);
        }
      } catch {
      }
    }
    if (cur && missed.indexOf(cur) < 0) missed.push(cur);
    const gone = (id) => skipped.indexOf(id) >= 0 || missed.indexOf(id) >= 0;
    const oldIdx = Number(t.offerIdx || 0);
    let idx = oldIdx + (cur ? 1 : 0);
    while (idx < q.length && gone(q[idx])) idx += 1;
    let missedJson = JSON.stringify(missed);
    if (idx >= q.length) {
      const again = q.filter((x) => skipped.indexOf(x) < 0);
      if (!again.length) {
        const r2 = await sql`UPDATE trips SET "offerBroadcast" = TRUE, "offerQueue" = ${JSON.stringify(q)}::jsonb, "offerMissed" = ${missedJson}::jsonb, "updatedAt" = NOW() WHERE id = ${t.id} AND status = 'REQUESTED' RETURNING *`;
        return r2[0] || t;
      }
      missed.length = 0;
      missedJson = JSON.stringify(missed);
      idx = q.indexOf(again[0]);
    }
    const expAt = new Date(Date.now() + OFFER_TTL_SEC * 1e3);
    const r = await sql`UPDATE trips SET "offerIdx" = ${idx}, "offeredDriverId" = ${q[idx]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAt}, "offerQueue" = ${JSON.stringify(q)}::jsonb, "offerMissed" = ${missedJson}::jsonb, "updatedAt" = NOW() WHERE id = ${t.id} AND status = 'REQUESTED' AND COALESCE("offerIdx", 0) = ${oldIdx} RETURNING *`;
    if (!r[0]) {
      const rr = await sql`SELECT * FROM trips WHERE id = ${t.id} LIMIT 1`;
      return rr[0] || t;
    }
    if (pushBody) await pushTripToDriver(sql, q[idx], t.id, pushBody.title, pushBody.body);
    return r[0];
  } catch {
    return t;
  }
}
app.post("/api/v1/trips/request-web", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const user = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const pLa = Number(b.pickupLat), pLo = Number(b.pickupLng);
  const dLa = Number(b.destLat), dLo = Number(b.destLng);
  const fare = Math.round(Number(b.fare)) || 0;
  if (!Number.isFinite(pLa) || !Number.isFinite(pLo) || !Number.isFinite(dLa) || !Number.isFinite(dLo) || fare <= 0) {
    return c.json({ message: "Pedido inv\xE1lido." }, 400);
  }
  try {
    const active = await sql`SELECT id, status FROM trips WHERE "passengerId" = ${user.sub} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') ORDER BY "createdAt" DESC LIMIT 1`;
    if (active.length && active[0].status !== "REQUESTED") return c.json({ message: "Avalia a tua \xFAltima viagem para pedir outra." }, 409);
    if (active.length) await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = 'Replaced by new booking', "updatedAt" = NOW() WHERE id = ${active[0].id}`;
    let pickupName = String(b.pickupName || "").slice(0, 60);
    if (!pickupName) {
      try {
        const zr = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pLa}&lon=${pLo}&format=json&zoom=14`, { headers: { "User-Agent": "LadiesGo/1.0" }, signal: AbortSignal.timeout(8e3) });
        const zj = await zr.json();
        const za = zj && zj.address || {};
        pickupName = za.suburb || za.neighbourhood || za.quarter || za.city_district || za.town || za.city || "";
      } catch {
      }
      if (!pickupName) {
        try {
          const br = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${pLa}&longitude=${pLo}&localityLanguage=pt`, { signal: AbortSignal.timeout(8e3) });
          const bj = await br.json();
          pickupName = bj.locality || bj.city || bj.principalSubdivision || "";
        } catch {
        }
      }
      if (!pickupName) pickupName = offlineZone(pLa, pLo) || "Ponto no mapa";
      pickupName = pickupName.slice(0, 60);
    }
    const dist = havKm(pLa, pLo, dLa, dLo);
    const stops = Array.isArray(b.stops) ? b.stops.slice(0, 3).map((x) => ({ n: String(x.n || "").slice(0, 60), a: String(x.a || "").slice(0, 80), lat: Number(x.lat), lng: Number(x.lng) })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng)) : [];
    const sched = Number(b.scheduledAt) > Date.now() ? new Date(Number(b.scheduledAt)) : null;
    const { byName } = await catMaps(sql);
    const rideCode = byName[String(b.cat)] || "ECONOMY";
    let q = [];
    try {
      q = await buildOfferQueue(c.env, sql, pLa, pLo, rideCode);
    } catch {
    }
    const hasQ = q.length > 0;
    const offerFirst = hasQ ? q[0] : null;
    const expAt = hasQ ? new Date(Date.now() + OFFER_TTL_SEC * 1e3) : null;
    const rows = await sql`
      INSERT INTO trips (id, "passengerId", "pickupAddress", "pickupLat", "pickupLng", "dropoffAddress", "dropoffLat", "dropoffLng",
        status, "rideType", "fareEstimate", "distanceKm", "paymentMethod", stops, "scheduledAt", "createdAt", "updatedAt",
        "offerQueue", "offerIdx", "offeredDriverId", "offeredAt", "offerExpiresAt", "offerBroadcast", "offerSkipped")
      VALUES (gen_random_uuid()::text, ${user.sub}, ${pickupName}, ${pLa}, ${pLo},
        ${String(b.destN || "").slice(0, 60) + " \xB7 " + String(b.destA || "").slice(0, 80)}, ${dLa}, ${dLo},
        'REQUESTED', ${rideCode}, ${fare}, ${Math.round(dist * 10) / 10},
        ${pay2method(b.pay)}, ${JSON.stringify(stops)}::jsonb, ${sched}, NOW(), NOW(),
        ${hasQ ? JSON.stringify(q) : null}, 0, ${hasQ ? q[0] : null}, ${hasQ ? (/* @__PURE__ */ new Date()).toISOString() : null}, ${expAt ? expAt.toISOString() : null}, ${hasQ ? 0 : 1}, ${hasQ ? "[]" : null})
      RETURNING id`;
    const tripId = rows[0].id;
    try {
      const destN = String(b.destN || "").slice(0, 60);
      c.executionCtx.waitUntil((async () => {
        if (!offerFirst) await pushTripToDrivers(sql, tripId, pickupName, destN, stops.length, fare, "\u{1F514} Novo pedido LadiesGo!", String(b.cat || ""));
        await ringStart(c.env);
        try {
          const fbTok = String(c.env.FB_SCRAPE_TOKEN || "");
          if (fbTok) await fetch("https://graph.facebook.com/v26.0/?id=" + encodeURIComponent("https://ladiesgo.pages.dev/t?id=" + tripId) + "&scrape=true&access_token=" + encodeURIComponent(fbTok), { method: "POST", signal: AbortSignal.timeout(1e4) });
        } catch {
        }
      })());
    } catch {
    }
    hubPoke(c, [String(b.cat || "")]);
    return c.json({ id: tripId });
  } catch (e) {
    console.error("request-web error:", e);
    return c.json({ message: "Falhou o pedido. Tenta de novo." }, 500);
  }
});
app.post("/api/v1/trips/:id/status", requireAuth, async (c) => {
  const sql = makeSql(c.env.DB);
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  const st = String(b.status || "");
  const neonSt = WEB2NEON[st];
  const okNext = { ACCEPTED: ["REQUESTED"], DRIVER_ARRIVED: ["ACCEPTED"], IN_PROGRESS: ["DRIVER_ARRIVED"], COMPLETED: ["IN_PROGRESS"], CANCELLED: ["REQUESTED", "ACCEPTED", "DRIVER_ARRIVED", "IN_PROGRESS"] };
  if (!neonSt || !okNext[neonSt]) return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
  try {
    const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
    if (!cur.length) return c.json({ message: "Viagem n\xE3o encontrada." }, 404);
    const t = cur[0];
    if (okNext[neonSt].indexOf(t.status) < 0) return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
    if (neonSt === "ACCEPTED") {
      const did = await driverIdFor(sql, String(b.driverId || ""));
      if (!did) return c.json({ message: "S\xF3 motoristas." }, 403);
      const busy = await sql`SELECT id FROM trips WHERE "driverId" = ${did} AND status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') LIMIT 1`;
      if (busy.length) return c.json({ message: "J\xE1 tens uma viagem ativa." }, 400);
      try {
        const oc = await sql`SELECT "offerQueue", "offerIdx", "offeredDriverId", "offerBroadcast", "offerExpiresAt", status FROM trips WHERE id = ${id} LIMIT 1`;
        if (oc.length && oc[0].status === "REQUESTED" && !oc[0].offerBroadcast && (offerQueueOf(oc[0]).length || oc[0].offeredDriverId)) {
          const fresh = await advanceOfferIfNeeded(c.env, sql, oc[0]);
          if (!fresh.offerBroadcast && String(fresh.offeredDriverId || "") !== did) {
            return c.json({ message: "Esta oferta j\xE1 passou para outra motorista." }, 409);
          }
        }
      } catch {
      }
      const acc = await sql`UPDATE trips SET "driverId" = ${did}, status = 'ACCEPTED', "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'REQUESTED' RETURNING *`;
      if (!acc.length) return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
    } else if (neonSt === "DRIVER_ARRIVED") {
      const r = await sql`UPDATE trips SET status = 'DRIVER_ARRIVED', "arrivedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'ACCEPTED'`;
      if (!r.length) return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
    } else if (neonSt === "IN_PROGRESS") {
      const r = await sql`UPDATE trips SET status = 'IN_PROGRESS', "startedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'DRIVER_ARRIVED'`;
      if (!r.length) return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
    } else if (neonSt === "COMPLETED") {
      const devTs = Number(b.ts);
      const doneAt = Number.isFinite(devTs) && Math.abs(devTs - Date.now()) <= 15 * 60 * 1e3 ? new Date(devTs) : /* @__PURE__ */ new Date();
      await sql`UPDATE trips SET status = 'COMPLETED', "finalFare" = COALESCE("finalFare", "fareEstimate"), "completedAt" = ${doneAt}, "updatedAt" = NOW() WHERE id = ${id}`;
      if (t.driverId) await sql`UPDATE drivers SET "totalTrips" = "totalTrips" + 1, "totalEarnings" = "totalEarnings" + ${Number(t.finalFare || t.fareEstimate || 0) * 0.8} WHERE id = ${t.driverId}`;
      await applyCommission(sql, t.driverId, t.finalFare || t.fareEstimate, id);
    } else if (neonSt === "CANCELLED") {
      const r = await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${String(b.by || "").slice(0, 16)}, "cancelReason" = ${String(b.reason || "").slice(0, 80)}, "updatedAt" = NOW() WHERE id = ${id} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')`;
      if (!r.length) return c.json({ message: "Transi\xE7\xE3o inv\xE1lida." }, 400);
    }
    pushStatus(c, id, neonSt);
    if (neonSt === "DRIVER_ARRIVED") {
      try {
        c.executionCtx.waitUntil(pushPaxArrived(c.env, id));
      } catch {
      }
    }
    if (neonSt === "ACCEPTED" || neonSt === "CANCELLED") hubPoke(c);
    return c.json({ ok: true, status: st });
  } catch (e) {
    console.error("trip status error:", e);
    return c.json({ message: "Falhou. Tenta de novo." }, 500);
  }
});
app.get("/api/v1/trips/public/:id", async (c) => {
  const sql = makeSql(c.env.DB);
  const id = c.req.param("id");
  try {
    const rows = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return c.json({ message: "Viagem n\xE3o encontrada." }, 404);
    const t = rows[0];
    const pu = await sql`SELECT name, phone FROM users WHERE id = ${t.passengerId} LIMIT 1`;
    let driver = null;
    if (t.driverId) {
      const d = await sql`
        SELECT d."userId", d."currentLat", d."currentLng", d.rating, d."carMake", d."carModel", d."carColor", d."carPlate", d."carPhoto", u.name, u.phone, u."profilePhoto"
        FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${t.driverId} LIMIT 1`;
      if (d.length) {
        const r = d[0];
        const live = r.userId ? await geoGet(c.env, String(r.userId)) : null;
        const lat = live && Number.isFinite(Number(live.lat)) ? Number(live.lat) : r.currentLat != null ? Number(r.currentLat) : null;
        const lng = live && Number.isFinite(Number(live.lng)) ? Number(live.lng) : r.currentLng != null ? Number(r.currentLng) : null;
        const carFull = [r.carMake, r.carModel].filter(Boolean).join(" ") + (r.carColor ? " \xB7 " + r.carColor : "");
        driver = { name: r.name || "Motorista", phone: r.phone || "", carFull, plate: r.carPlate || "", rating: r.rating != null ? Number(r.rating) : null, photo: r.carPhoto || r.profilePhoto || "", lat, lng };
      }
    }
    const stops = Array.isArray(t.stops) ? t.stops : [];
    return c.json({
      status: t.status,
      pickup: { name: String(t.pickupAddress || ""), lat: Number(t.pickupLat), lng: Number(t.pickupLng) },
      dest: { name: String(t.dropoffAddress || ""), lat: Number(t.dropoffLat), lng: Number(t.dropoffLng) },
      stops: stops.map((s) => ({ n: String(s.n || ""), a: String(s.a || ""), lat: Number(s.lat), lng: Number(s.lng) })),
      cancelledBy: t.cancelledBy || "",
      cancelReason: t.cancelReason || "",
      createdAt: t.createdAt || "",
      updatedAt: t.updatedAt || "",
      driver,
      passenger: { name: pu[0]?.name || "Passageira", phone: pu[0]?.phone || "" }
    });
  } catch (e) {
    console.error("public trip error:", e);
    return c.json({ message: "Falhou. Tenta de novo." }, 500);
  }
});
app.post("/api/v1/trips/:id/position", requireAuth, async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  const la = Number(b.lat), lo = Number(b.lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: "Posi\xE7\xE3o inv\xE1lida." }, 400);
  paxLive.set(id, { lat: la, lng: lo, ts: Date.now() });
  return c.json({ ok: true });
});
async function pushTripToDrivers(sql, tripId, pickupName, destN, stopsN, fare, title, catName) {
  try {
    const cands = await sql`SELECT u."fcmToken", d.cats FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND u."fcmToken" LIKE 'ExponentPushToken%' AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')) LIMIT 100`;
    const toks = cands.filter((r) => !catName || !Array.isArray(r.cats) || !r.cats.length || r.cats.map((x) => String(x)).indexOf(catName) >= 0);
    const body = `${pickupName} \u2192 ${destN}${stopsN ? ` \xB7 +${stopsN} paragem${stopsN > 1 ? "ns" : ""}` : ""} \xB7 ${fare} Kz`;
    const msgs = toks.map((r) => ({ to: r.fcmToken, sound: "default", title, body, data: { tripId, type: "new-trip" } })).filter((m) => m.to);
    if (msgs.length) await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msgs) });
  } catch {
  }
}
var TripRinger = class {
  state;
  env;
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.endsWith("/cancel")) {
      try {
        await this.state.storage.deleteAlarm();
      } catch {
      }
      return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
    }
    const now = Date.now();
    const lastKick = await this.state.storage.get("lastKick") || 0;
    if (now - lastKick > 6e4) await this.state.storage.put("sent", 0);
    await this.state.storage.put("lastKick", now);
    try {
      await this.state.storage.put("ticks", 0);
    } catch {
    }
    await this.state.storage.setAlarm(now + 4e3);
    return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
  }
  async alarm() {
    try {
      const sent = await this.state.storage.get("sent") || 0;
      const ticks = (await this.state.storage.get("ticks") || 0) + 1;
      try {
        await this.state.storage.put("ticks", ticks);
      } catch {
      }
      const nextMs = ticks <= 2 ? 4e3 : ticks <= 4 ? 8e3 : 15e3;
      const sql = makeSql(this.env.DB);
      const rows = await sql`
        SELECT id, "pickupAddress", "dropoffAddress", "fareEstimate", stops, "rideType" FROM trips
        WHERE status = 'REQUESTED' AND "createdAt" > NOW() - INTERVAL '6 minutes'
        ORDER BY "createdAt" ASC LIMIT 20`;
      if (!rows.length) return;
      if (rows.length === 1) {
        const t = rows[0];
        try {
          const ch = await sql`SELECT id FROM chat_messages WHERE "tripId" = ${t.id} AND "createdAt" > NOW() - INTERVAL '3 minutes' LIMIT 1`;
          if (ch.length) {
            await this.state.storage.setAlarm(Date.now() + nextMs);
            return;
          }
        } catch {
        }
        const addr = String(t.dropoffAddress || "Luanda");
        const cut = addr.indexOf(" \xB7 ");
        const { byCode } = await catMaps(sql);
        try {
          const full = await sql`SELECT * FROM trips WHERE id = ${t.id} LIMIT 1`;
          if (full.length && !full[0].offerBroadcast && (offerQueueOf(full[0]).length || full[0].offeredDriverId)) {
            const prevOff = String(full[0].offeredDriverId || "");
            const prevIdx = Number(full[0].offerIdx || 0);
            const fresh = await advanceOfferIfNeeded(this.env, sql, full[0]);
            if (!fresh.offerBroadcast) {
              const offId = String(fresh.offeredDriverId || "");
              const ringKey = t.id + ":" + offId;
              const ringKeyStored = String(await this.state.storage.get("ringKey") || "");
              let ringN = Number(await this.state.storage.get("ringN") || 0);
              if (ringKey !== ringKeyStored) {
                ringN = 0;
                await this.state.storage.put("ringKey", ringKey);
              }
              if (offId && ringN < 4) {
                await pushTripToDriver(sql, offId, t.id, "\u{1F514} Novo pedido LadiesGo!", `${String(fresh.pickupAddress || "Ponto no mapa")} \u2192 ${String(fresh.dropoffAddress || "").split(" \xB7 ")[0]} \xB7 ${Number(fresh.fareEstimate || 0)} Kz`);
                ringN += 1;
                await this.state.storage.put("ringN", ringN);
              }
              if (offId !== prevOff || Number(fresh.offerIdx || 0) !== prevIdx) {
                try {
                  await hubBroadcast(this.env);
                } catch {
                }
              }
              await this.state.storage.setAlarm(Date.now() + nextMs);
              return;
            }
          }
        } catch {
        }
        if (sent < 3) {
          try {
            await hubBroadcast(this.env);
          } catch {
          }
          await pushTripToDrivers(sql, t.id, String(t.pickupAddress || "Ponto no mapa"), cut >= 0 ? addr.slice(0, cut) : addr, Array.isArray(t.stops) ? t.stops.length : 0, Number(t.fareEstimate || 0), "\u{1F514} Novo pedido LadiesGo!", byCode[t.rideType] || "");
          await this.state.storage.put("sent", sent + 1);
        }
      } else {
        if (sent >= 3) {
          try {
            await this.state.storage.setAlarm(Date.now() + 15e3);
          } catch {
          }
          return;
        }
        let openN = rows.length;
        try {
          const oc = await sql`SELECT COUNT(*)::int AS n FROM trips WHERE status = 'REQUESTED' AND "createdAt" > NOW() - INTERVAL '6 minutes' AND ("offerBroadcast" = TRUE OR "offerQueue" IS NULL)`;
          openN = Number(oc[0]?.n || 0);
        } catch {
        }
        if (!openN) {
          try {
            await this.state.storage.setAlarm(Date.now() + 1e4);
          } catch {
          }
          return;
        }
        try {
          await hubBroadcast(this.env);
        } catch {
        }
        try {
          const toks = await sql`SELECT u."fcmToken" FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND u."fcmToken" LIKE 'ExponentPushToken%' AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')) LIMIT 100`;
          const msgs = toks.map((r) => ({
            to: r.fcmToken,
            sound: "default",
            title: "\u{1F514} Viagens dispon\xEDveis \u2014 LadiesGo!",
            body: `Tens ${openN} pedido${openN > 1 ? "s" : ""} \xE0 espera \xB7 abre a app`,
            data: { type: "pending-summary" }
          })).filter((m) => m.to);
          if (msgs.length) await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msgs) });
        } catch {
        }
        await this.state.storage.put("sent", sent + 1);
      }
      await this.state.storage.setAlarm(Date.now() + nextMs);
    } catch {
      try {
        await this.state.storage.setAlarm(Date.now() + 1e4);
      } catch {
      }
    }
  }
};
var PUSH_GPS_MIN_MS = 1e4;
var PUSH_STATUS_TTL_MS = 15e3;
var TripPush = class {
  state;
  env;
  driver = null;
  passenger = null;
  status = null;
  statusAt = 0;
  tripCache = null;
  tripId = null;
  statusLoaded = false;
  lastEta = null;
  constructor(state, env) {
    this.state = state;
    this.env = env;
    try {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {
    }
  }
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname.endsWith("/notify")) {
      try {
        const b = await req.json().catch(() => ({}));
        const st = String(b?.status || "").toUpperCase().slice(0, 20);
        if (st) {
          await this.hydrate();
          const changed = this.status !== st;
          this.status = st;
          this.statusAt = Date.now();
          if (changed) {
            await this.persistStatus();
            this.broadcast({ t: "status", status: st });
            this.pushEta();
          }
        }
      } catch {
      }
      return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
    }
    if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
      return new Response("Expected websocket", { status: 426 });
    const tripId = String(req.headers.get("X-Trip-Id") || u.pathname.split("/").pop() || "").slice(0, 64);
    if (!tripId) return new Response("Missing trip", { status: 400 });
    this.tripId = tripId;
    try {
      await this.state.storage.put("tripId", tripId);
    } catch {
    }
    try {
      await this.hydrate();
    } catch {
    }
    try {
      await this.refreshStatus(false);
    } catch {
    }
    const uid = String(req.headers.get("X-User-Id") || "");
    const tag = req.headers.get("X-Is-Driver") === "1" ? "driver" : "pax";
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    try {
      this.state.acceptWebSocket(server, [tag, `u:${uid.slice(0, 32)}`]);
    } catch {
      return new Response("WS failed", { status: 500 });
    }
    try {
      server.serializeAttachment({ lastFixAt: 0, pushLat: 0, pushLng: 0, pushAt: 0, lastPaxAt: 0, uid });
    } catch {
    }
    try {
      server.send(JSON.stringify(this.helloFrame()));
    } catch {
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  helloFrame() {
    const hello = { t: "hello", tripId: this.tripId };
    if (this.status) hello.status = this.status;
    if (this.driver && Date.now() - this.driver.ts < 12e4) hello.driver = { lat: this.driver.lat, lng: this.driver.lng };
    if (this.passenger && String(this.status || "") !== "IN_PROGRESS" && Date.now() - this.passenger.ts < 12e4) hello.pax = { lat: this.passenger.lat, lng: this.passenger.lng };
    return hello;
  }
  // Estado persistido: sobrevive à hibernação (sem isto um DO acordado reenviava
  // "status" ao julgar que mudou de null -> valor).
  async hydrate() {
    if (this.statusLoaded) return;
    this.statusLoaded = true;
    try {
      const s = await this.state.storage.get("status");
      if (!this.status && s) this.status = String(s);
    } catch {
    }
  }
  async persistStatus() {
    this.statusLoaded = true;
    try {
      await this.state.storage.put("status", this.status);
    } catch {
    }
  }
  // Só emite ETA quando o valor muda (evita frames repetidos).
  pushEta() {
    const eta = this.etaMin();
    if (eta == null || this.lastEta === eta) return;
    this.lastEta = eta;
    this.broadcast({ t: "eta", min: eta });
  }
  async webSocketMessage(ws, raw2) {
    let m;
    try {
      m = JSON.parse(typeof raw2 === "string" ? raw2 : String(raw2));
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.t === "gps") {
      await this.onGps(ws, m).catch(() => {
      });
      return;
    }
    if (m.t === "chat") {
      const text = String(m.text || "").trim().slice(0, 300);
      if (!text) return;
      this.broadcastExcept(ws, { t: "chat", text, from: String(m.from || "").slice(0, 40), ts: Date.now() });
      return;
    }
    if (m.t === "state") {
      await this.refreshStatus(true).catch(() => null);
      try {
        ws.send(JSON.stringify({ t: "state", status: this.status, driver: this.driver ? { lat: this.driver.lat, lng: this.driver.lng } : null, pax: this.passenger ? { lat: this.passenger.lat, lng: this.passenger.lng } : null, etaMin: this.etaMin(), ts: Date.now() }));
      } catch {
      }
      return;
    }
  }
  async webSocketClose(_ws, _code, _reason, _wasClean) {
  }
  async webSocketError(ws, _err) {
    try {
      ws.close(1011, "err");
    } catch {
    }
  }
  async onGps(ws, m) {
    let tags = [];
    try {
      tags = this.state.getTags(ws) || [];
    } catch {
    }
    const claimed = String(m?.role || "").toLowerCase();
    const la = Number(m?.lat), lo = Number(m?.lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return;
    const now = Date.now();
    const att = (() => {
      try {
        return ws.deserializeAttachment() || {};
      } catch {
        return {};
      }
    })();
    if (tags.indexOf("driver") >= 0 && claimed === "driver") {
      if (now - Number(att.lastFixAt || 0) < PUSH_GPS_MIN_MS) return;
      att.lastFixAt = now;
      this.driver = { lat: la, lng: lo, ts: now };
      try {
        const _gp = geoSet(this.env, { userId: String(att.uid || ""), lat: la, lng: lo });
        try {
          this.state.waitUntil(_gp);
        } catch {
        }
      } catch {
      }
      await this.refreshStatus(false);
      const movedKm = att.pushAt ? havKm(Number(att.pushLat), Number(att.pushLng), la, lo) : 1;
      if (movedKm >= 0.15 || now - Number(att.pushAt || 0) >= 3e4) {
        att.pushLat = la;
        att.pushLng = lo;
        att.pushAt = now;
        this.broadcastExcept(ws, { t: "driver", lat: la, lng: lo, ts: now });
        this.pushEta();
      }
      try {
        ws.serializeAttachment(att);
      } catch {
      }
      return;
    }
    if (tags.indexOf("pax") >= 0 && claimed === "pax") {
      if (now - Number(att.lastPaxAt || 0) < PUSH_GPS_MIN_MS) return;
      att.lastPaxAt = now;
      this.passenger = { lat: la, lng: lo, ts: now };
      if (String(this.status || "") !== "IN_PROGRESS") {
        this.broadcastExcept(ws, { t: "pax", lat: la, lng: lo, ts: now });
      }
      try {
        ws.serializeAttachment(att);
      } catch {
      }
      return;
    }
  }
  async refreshStatus(force) {
    const now = Date.now();
    if (!force && now - this.statusAt < PUSH_STATUS_TTL_MS) return this.status;
    if (!this.tripId) {
      try {
        this.tripId = await this.state.storage.get("tripId");
      } catch {
      }
    }
    if (!this.tripId) return this.status;
    try {
      await this.hydrate();
    } catch {
    }
    const sql = makeSql(this.env.DB);
    const rows = await sql`SELECT status, "pickupLat", "pickupLng", "dropoffLat", "dropoffLng" FROM trips WHERE id = ${this.tripId} LIMIT 1`;
    this.statusAt = now;
    if (!rows.length) return this.status;
    const r = rows[0];
    this.tripCache = r;
    if (r.status && r.status !== this.status) {
      this.status = r.status;
      await this.persistStatus();
      this.broadcast({ t: "status", status: r.status });
      this.pushEta();
    }
    return this.status;
  }
  etaMin() {
    try {
      if (!this.driver || !this.tripCache) return null;
      const st = String(this.status || "");
      const tLa = Number(st === "IN_PROGRESS" ? this.tripCache.dropoffLat : this.tripCache.pickupLat);
      const tLo = Number(st === "IN_PROGRESS" ? this.tripCache.dropoffLng : this.tripCache.pickupLng);
      if (!Number.isFinite(tLa) || !Number.isFinite(tLo)) return null;
      const dk = havKm(this.driver.lat, this.driver.lng, tLa, tLo);
      return Math.max(1, Math.ceil(dk / 30 * 60));
    } catch {
      return null;
    }
  }
  broadcast(obj) {
    let msg = "";
    try {
      msg = JSON.stringify(obj);
    } catch {
      return;
    }
    let socks = [];
    try {
      socks = this.state.getWebSockets();
    } catch {
      return;
    }
    for (const s of socks) {
      try {
        s.send(msg);
      } catch {
      }
    }
  }
  broadcastExcept(ws, obj) {
    let msg = "";
    try {
      msg = JSON.stringify(obj);
    } catch {
      return;
    }
    let socks = [];
    try {
      socks = this.state.getWebSockets();
    } catch {
      return;
    }
    for (const s of socks) {
      if (s === ws) continue;
      try {
        s.send(msg);
      } catch {
      }
    }
  }
};
var RequestsHub = class {
  state;
  env;
  constructor(state, env) {
    this.state = state;
    this.env = env;
    try {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {
    }
  }
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname.endsWith("/broadcast")) {
      try {
        const b = await req.json().catch(() => ({}));
        const cats2 = Array.isArray(b?.cats) && b.cats.length ? b.cats.map((x) => String(x)) : null;
        const driverId2 = String(b?.driverId || "");
        const msg = JSON.stringify({ t: "refresh", ts: Date.now() });
        for (const s of this.socks()) {
          try {
            const a = s.deserializeAttachment && s.deserializeAttachment() || {};
            if (driverId2 && String(a.driverId || "") !== driverId2) continue;
            const sc = Array.isArray(a.cats) ? a.cats : [];
            if (cats2 && sc.length && !sc.some((c) => cats2.indexOf(c) >= 0)) continue;
            s.send(msg);
          } catch {
          }
        }
      } catch {
      }
      return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
    }
    if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
      return new Response("Expected websocket", { status: 426 });
    const driverId = String(req.headers.get("X-Driver-Id") || "");
    let cats = [];
    try {
      cats = JSON.parse(req.headers.get("X-Cats") || "[]");
    } catch {
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    try {
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ driverId, cats });
    } catch {
      return new Response("WS failed", { status: 500 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(_ws, _raw) {
  }
  async webSocketClose(_ws, _code, _reason, _wasClean) {
  }
  async webSocketError(ws, _err) {
    try {
      ws.close(1011, "err");
    } catch {
    }
  }
  socks() {
    try {
      return this.state.getWebSockets();
    } catch {
      return [];
    }
  }
};
var DriverGeo = class {
  state;
  env;
  pos;
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pos = /* @__PURE__ */ new Map();
    try {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {
    }
  }
  json(o) {
    return new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
  }
  // A hibernação do DO limpa a memória. Sem isto, as posições desapareciam
  // quando o objeto ficava ocioso e a passagreira deixava de ver carros.
  loaded = false;
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const all = await this.state.storage.list({ prefix: "p:" });
      const now = Date.now();
      for (const [k, v] of all) {
        const uid = String(k).slice(2);
        if (!this.pos.has(uid) && v && now - Number(v.ts || 0) <= 18 * 60 * 1e3) this.pos.set(uid, v);
      }
    } catch {
    }
  }
  // Aplica uma atualização de posição vinda de HTTP (/set) ou de mensagem WS.
  setPos(userId, lat, lng, cats, online) {
    const prev = this.pos.get(userId) || null;
    const wasOnline = !!prev?.online;
    this.pos.set(userId, {
      userId,
      driverId: prev?.driverId || "",
      lat,
      lng,
      // Categorias só podem mudar com a motorista offline (regra de negócio):
      // com a sessão online, mantém as categorias já em vigor.
      cats: prev && prev.online ? prev.cats || null : cats != null ? cats : prev?.cats || null,
      online: online != null ? !!online : !!prev?.online,
      ts: Date.now()
    });
    return wasOnline;
  }
  // Espelha a transição online/offline da ligação WS na D1, para o filtro
  // "isOnline" do buildOfferQueue e do /trips/incoming ficar correto (a
  // presença por WS não passava pelo /drivers/position).
  async d1Online(userId, online) {
    try {
      const sql = makeSql(this.env.DB);
      await sql`UPDATE drivers SET "isOnline" = ${online}, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
    } catch {
    }
  }
  async fetch(req) {
    const u = new URL(req.url);
    const path = u.pathname;
    if (path.endsWith("/live")) {
      if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
        return new Response("Expected websocket", { status: 426 });
      const userId = String(req.headers.get("X-User-Id") || "");
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      try {
        this.state.acceptWebSocket(server);
        server.serializeAttachment({ userId });
      } catch {
        return new Response("WS failed", { status: 500 });
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method === "POST" && path.endsWith("/set")) {
      const b = await req.json().catch(() => ({}));
      const userId = String(b.userId || "");
      if (!userId) return this.json({ wasOnline: false });
      await this.load();
      const wasOnline = this.setPos(userId, Number(b.lat), Number(b.lng), b.cats, b.online != null ? !!b.online : null);
      return this.json({ wasOnline });
    }
    if (req.method === "POST" && path.endsWith("/del")) {
      const b = await req.json().catch(() => ({}));
      const uid = String(b.userId || "");
      this.pos.delete(uid);
      try {
        this.state.storage.delete("p:" + uid).catch(() => {
        });
      } catch {
      }
      return this.json({ ok: true });
    }
    if (path.endsWith("/get")) {
      const uid = String(u.searchParams.get("userId") || "");
      await this.load();
      return this.json({ driver: this.pos.get(uid) || null });
    }
    if (path.endsWith("/all")) {
      await this.load();
      const now = Date.now();
      const drivers = [];
      for (const v of this.pos.values()) {
        if (now - Number(v.ts || 0) <= 18 * 60 * 1e3) drivers.push(v);
      }
      return this.json({ drivers });
    }
    return new Response("not found", { status: 404 });
  }
  async webSocketMessage(ws, raw2) {
    const bytes = typeof raw2 === "string" ? new TextEncoder().encode(raw2).length : raw2?.byteLength || 0;
    if (bytes > WS_MAX_MESSAGE_BYTES) {
      try {
        ws.close(1009, "mensagem grande");
      } catch {
      }
      return;
    }
    const a = ws.deserializeAttachment && ws.deserializeAttachment() || {};
    const userId = String(a.userId || "");
    if (!userId) return;
    if (!a.bucket) a.bucket = newBucket();
    if (!tryConsume(a.bucket)) return;
    ws.serializeAttachment(a);
    let m = null;
    try {
      m = JSON.parse(typeof raw2 === "string" ? raw2 : "");
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.offline) {
      this.pos.delete(userId);
      try {
        this.state.storage.delete("p:" + userId).catch(() => {
        });
      } catch {
      }
      await this.d1Online(userId, false);
      return;
    }
    const lat = Number(m.lat), lng = Number(m.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const cats = Array.isArray(m.cats) ? m.cats.map((x) => String(x).slice(0, 30)).slice(0, 6) : null;
    await this.load();
    const wasOnline = this.setPos(userId, lat, lng, cats, true);
    if (!wasOnline) await this.d1Online(userId, true);
  }
  async webSocketClose(_ws, _code, _reason, _wasClean) {
  }
  async webSocketError(ws, _err) {
    try {
      ws.close(1011, "err");
    } catch {
    }
  }
};
async function ringStart(env) {
  try {
    const stub = env.RINGER.get(env.RINGER.idFromName("global"));
    await stub.fetch("https://ringer/kick");
  } catch {
  }
}
var index_default = {
  fetch: app.fetch
};
export {
  DriverGeo,
  RequestsHub,
  TripPush,
  TripRinger,
  index_default as default
};
