const Promise = require('bluebird');
const gcloud = require('gcloud');
const AbstractFileTransfer = require('ms-files-transport');
const ld = require('lodash');
const ResumableUpload = Promise.promisifyAll(require('gcs-resumable-upload'));
const Errors = require('common-errors');

/**
 * Extends class, so that if we have contentLength metadata header - it's included in the request options
 */
class MMResumableUpload extends ResumableUpload {
  makeRequest(reqOpts, callback) {
    if (this.metadata.contentLength) {
      const headers = reqOpts.headers || {};
      headers['X-Upload-Content-Length'] = this.metadata.contentLength;
      reqOpts.headers = headers;
    }

    super.makeRequest(reqOpts, function processResponse(err, resp, body) {
      if (err) {
        if (err instanceof Error) {
          return callback(err);
        }

        const error = new Errors.Error(err.message);
        Object.assign(error, err);
        return callback(err);
      }

      callback(null, resp, body);
    });
  }
}

/**
 * Main transport class
 */
module.exports = class GCETransport extends AbstractFileTransfer {

  static defaultOpts = {
    gce: {
      // specify authentication options
      // here
    },
    bucket: {
      // specify bucket
      name: 'must-be-a-valid-bucket-name',
      host: 'storage.cloud.google.com',
      metadata: {},
    },
  };

  constructor(opts = {}) {
    super();
    this._config = ld.merge({}, GCETransport.defaultOpts, opts);

    if (this._config.logger) {
      this._logger = this._config.logger;
    } else {
      [ 'trace', 'debug', 'info', 'warn', 'error', 'fatal' ].reduce((acc, act) => {
        acc[act] = ld.noop;
        return acc;
      }, (this._logger = {}));
    }

    this.setupGCE();
  }

  /**
   * Returns logger or noop
   * @return {[type]} [description]
   */
  get log() {
    return this._logger;
  }

  /**
   * Creates authenticated instance of gcloud
   */
  setupGCE() {
    const gce = this._gce = gcloud(this._config.gce);
    this._gcs = Promise.promisifyAll(gce.storage(), { multiArgs: true });
  }

  /**
   * Creates bucket if it doesn't exist, otherwise
   * returns an existing one
   * @param  {Object} [query]
   * @return {Promise}
   */
  createBucket(query) {
    const gcs = this._gcs;
    const needle = this._config.bucket.name;

    this.log.debug('initiating createBucket: %s', needle);

    return gcs.getBucketsAsync(query)
      .spread((buckets, nextQuery) => {
        const bucket = ld.findWhere(buckets, { name: needle });
        if (bucket) {
          this.log.debug('found existing bucket');
          return bucket;
        }

        if (nextQuery) {
          this.log.debug('not found, next query:', nextQuery);
          return this.createBucket(nextQuery);
        }

        this.log.debug('creating bucket', needle, this._config.bucket.metadata);
        return gcs.createBucketAsync(needle, this._config.bucket.metadata);
      });
  }

  /**
   * Ensures that we have rights to write to the
   * specified bucket
   * @return {Promise}
   */
  connect() {
    return this.createBucket()
      .tap(bucket => {
        this._bucket = bucket;
      });
  }

  /**
   * Creates signed URL
   *
   * StringToSign = HTTP_Verb + "\n" +
   *    Content_MD5 + "\n" +
   *    Content_Type + "\n" +
   *    Expiration + "\n" +
   *    Canonicalized_Extension_Headers +
   *    Canonicalized_Resource
   *
   * @param {String="read","write","delete"} action
   * @param {String} [type]   Content-Type, do not supply for downloads
   * @param {String} resource `/path/to/objectname/without/bucket`
   *                          You construct the Canonicalized_Resource portion of the message by concatenating the resource path (bucket and object and subresource) that the request is acting on. To do this, you can use the following process:
   *                          * Begin with an empty string.
   *                          * If the bucket name appears in the Host header, add a slash and the bucket name to the string (for example, /example-travel-maps). If the bucket name appears in the path portion of the HTTP request, do nothing.
   *                          * Add the path portion of the HTTP request to the string, excluding any query string parameters. For example, if the path is /europe/france/paris.jpg?cors and you already added the bucket example-travel-maps to the string, then you need to add /europe/france/paris.jpg to the string.
   *                          * If the request is scoped to a subresource, such as ?cors, add this subresource to the string, including the question mark.
   *                          * Be sure to copy the HTTP request path literally: that is, you should include all URL encoding (percent signs) in the string that you create. Also, be sure that you include only query string parameters that designate subresources (such as cors). You should not include query string parameters such as ?prefix, ?max-keys, ?marker, and ?delimiter.
   * @param {String} [md5] - md5 digest of content - Optional. The MD5 digest value in base64. If you provide this in the string,
   *                 the client (usually a browser) must provide this HTTP header with this same value in its request.
   * @param {Number} expires   This is the timestamp (represented as the number of miliseconds since the Unix Epoch of 00:00:00 UTC on January 1, 1970)
   *                            when the signature expires
   * @param {String} [extensionHeaders] :
   *        									 You construct the Canonical Extension Headers portion of the message by concatenating all extension (custom) headers that begin
   *                           with x-goog-. However, you cannot perform a simple concatenation. You must concatenate the headers using the following process:
   *                           * Make all custom header names lowercase.
   *                           * Sort all custom headers by header name using a lexicographical sort by code point value.
   *                           * Eliminate duplicate header names by creating one header name with a comma-separated list of values. Be sure there is no
   *                           whitespace between the values and be sure that the order of the comma-separated list matches the order that the headers
   *                           appear in your request. For more information, see RFC 2616 section 4.2.
   *                           * Replace any folding whitespace or newlines (CRLF or LF) with a single space. For more information about folding whitespace,
   *                           see RFC 2822 section 2.2.3.
   *                           * Remove any whitespace around the colon that appears after the header name.
   *                           * Append a newline (U+000A) to each custom header.
   *                           * Concatenate all custom headers.
   *                           Important: You must use both the header name and the header value when you construct the Canonical Extension Headers portion of the query string. Be sure to remove any whitespace around the colon that separates the header name and value. For example, using the custom header x-goog-acl: private without removing the space after the colon will return a 403 Forbidden because the request signature you calculate will not match the signature Google calculates.
   * @return {Promise}
   */
  createSignedURL(opts) {
    this.log.debug('initiating signing of URL for %s', opts.resource);

    const { action, md5, type, expires, extensionHeaders, resource } = opts;
    const file = this.bucket(resource);
    return Promise.fromNode(next => {
      file.getSignedUrl({
        action,
        expires,
        contentMd5: md5,
        contentType: type,
        extensionHeaders,
      }, next);
    });
  }

  /**
   * Initializes resumable upload
   * @param  {Object} opts
   * @param  {String} opts.filename
   * @param  {Object} opts.metadata
   * @param  {String} opts.metadata.contentLength
   * @param  {String} opts.metadata.contentType - must be included
   * @param  {String} opts.metadata.md5Hash - must be included
   * @param  {String} [opts.metadata.contentEncoding] - optional, can be set to gzip
   * @return {Promise}
   */
  initResumableUpload(opts) {
    const { filename, metadata, generation } = opts;
    this.log.debug('initiating resumable upload of %s', filename);

    return MMResumableUpload.createURIAsync({
      authClient: this.bucket.storage.authClient,
      bucket: this.bucket.name,
      file: filename,
      generation,
      metadata,
    });
  }

  /**
   * Download file
   * @param {String} filename - what do we want to download
   * @param {Object} opts
   * @param {Number} [opts.start]
   * @param {Number} [opts.end]
   * @param {Function} opts.onError    - returns error if it happens
   * @param {Function} opts.onResponse - returns response headers and status
   * @param {Function} opts.onData     - returns data chunks
   * @param {Function} opts.onEnd      - fired when transfer is completed
   */
  readFile(filename, opts) {
    this.log.debug('initiating read of %s', filename);

    const file = this.bucket(filename);
    return file.createReadStream({ start: opts.start || 0, end: opts.end || undefined })
      .on('error', opts.onError)
      .on('response', opts.onResponse)
      .on('data', opts.onData)
      .on('end', opts.onEnd);
  }

  /**
   * Tells whether file exists or not
   * @param  {String} filename
   * @return {Promise}
   */
  exists(filename) {
    this.log.debug('initiating exists check of %s', filename);

    const file = this.bucket(filename);
    return Promise.fromNode(next => {
      file.exists(next);
    });
  }

};
