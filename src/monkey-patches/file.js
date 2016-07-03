/* eslint-disable prefer-template */

const File = require('gcloud/lib/storage/file');
const createErrorClass = require('create-error-class');
const format = require('string-format-obj');
const crypto = require('crypto');
const is = require('is');

/**
 * Custom error type for errors related to getting signed errors and policies.
 *
 * @private
 *
 * @param {string} message - Custom error message.
 * @return {Error}
 */
const SigningError = createErrorClass('SigningError', function signError(message) {
  this.message = message;
});

/**
 * Get a signed URL to allow limited time access to the file.
 *
 * @resource [Signed URLs Reference]{@link https://cloud.google.com/storage/docs/access-control#Signed-URLs}
 *
 * @throws {Error} if an expiration timestamp from the past is given.
 *
 * @param {object} config - Configuration object.
 * @param {string} config.action - "read" (HTTP: GET), "write" (HTTP: PUT), or
 *     "delete" (HTTP: DELETE).
 * @param {string=} config.contentMd5 - The MD5 digest value in base64. If you
 *     provide this, the client must provide this HTTP header with this same
 *     value in its request.
 * @param {string=} config.contentType - If you provide this value, the client
 *     must provide this HTTP header set to the same value.
 * @param {*} config.expires - A timestamp when this link will expire. Any value
 *     given is passed to `new Date()`.
 * @param {object=} config.extensionHeaders - If these headers are used, the
 *     server will check to make sure that the client provides matching values.
 * @param {string=} config.promptSaveAs - The filename to prompt the user to
 *     save the file as when the signed url is accessed. This is ignored if
 *     `config.responseDisposition` is set.
 * @param {string=} config.responseDisposition - The
 *     [response-content-disposition parameter](http://goo.gl/yMWxQV) of the
 *     signed url.
 * @param {string=} config.responseType - The response-content-type parameter
 *     of the signed url.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {string} callback.url - The signed URL.
 *
 * @example
 * //-
 * // Generate a URL that allows temporary access to download your file.
 * //-
 * var request = require('request');
 *
 * file.getSignedUrl({
 *   action: 'read',
 *   expires: '03-17-2025'
 * }, function(err, url) {
 *   if (err) {
 *     console.error(err);
 *     return;
 *   }
 *
 *   // The file is now available to read from this URL.
 *   request(url, function(err, resp) {
 *     // resp.statusCode = 200
 *   });
 * });
 *
 * //-
 * // Generate a URL to allow write permissions. This means anyone with this URL
 * // can send a POST request with new data that will overwrite the file.
 * //-
 * file.getSignedUrl({
 *   action: 'write',
 *   expires: '03-17-2025'
 * }, function(err, url) {
 *   if (err) {
 *     console.error(err);
 *     return;
 *   }
 *
 *   // The file is now available to be written to.
 *   var writeStream = request.put(url);
 *   writeStream.end('New data');
 *
 *   writeStream.on('complete', function(resp) {
 *     // Confirm the new content was saved.
 *     file.download(function(err, fileContents) {
 *       console.log('Contents:', fileContents.toString());
 *       // Contents: New data
 *     });
 *   });
 * });
 */
File.prototype.getSignedUrl = function getSignedUrl(_config, callback) {
  const expires = new Date(_config.expires);
  const expiresInSeconds = Math.round(expires / 1000); // The API expects seconds.

  if (expires < Date.now()) {
    throw new Error('An expiration date cannot be in the past.');
  }

  const config = { ..._config };

  config.action = {
    read: 'GET',
    write: 'PUT',
    delete: 'DELETE',
  }[config.action];

  const name = encodeURIComponent(this.name);
  const targetGeneration = this.generation;

  const host = config.cname || `https://storage.googleapis.com/${this.bucket.name}`;
  config.resource = `/${this.bucket.name}/${name}`;

  this.storage.getCredentials((err, credentials) => {
    if (err) {
      callback(new SigningError(err.message));
      return;
    }

    if (!credentials.private_key || !credentials.client_email) {
      const errorMessage = [
        'Could not find a `private_key` or `client_email`.',
        'Please verify you are authorized with these credentials available.',
      ].join(' ');

      callback(new SigningError(errorMessage));
      return;
    }

    const extensionHeaders = config.extensionHeaders;
    let extensionHeadersString = '';
    if (extensionHeaders) {
      Object.keys(extensionHeaders).forEach(headerName => {
        extensionHeadersString += format('{name}:{value}\n', {
          name: headerName,
          value: extensionHeaders[headerName],
        });
      });
    }

    const sign = crypto.createSign('RSA-SHA256');
    sign.update([
      config.action,
      (config.contentMd5 || ''),
      (config.contentType || ''),
      expiresInSeconds,
      extensionHeadersString + config.resource,
    ].join('\n'));
    const signature = sign.sign(credentials.private_key, 'base64');

    let responseContentType = '';
    if (is.string(config.responseType)) {
      responseContentType =
        '&response-content-type=' +
        encodeURIComponent(config.responseType);
    }

    let responseContentDisposition = '';
    if (is.string(config.promptSaveAs)) {
      responseContentDisposition =
        '&response-content-disposition=attachment; filename="' +
        encodeURIComponent(config.promptSaveAs) + '"';
    }
    if (is.string(config.responseDisposition)) {
      responseContentDisposition =
        '&response-content-disposition=' +
        encodeURIComponent(config.responseDisposition);
    }

    let generation = '';
    if (!is.undefined(targetGeneration)) {
      generation = '&generation=' + targetGeneration;
    }

    callback(null, [
      host + '/' + name,
      '?GoogleAccessId=' + credentials.client_email,
      '&Expires=' + expiresInSeconds,
      '&Signature=' + encodeURIComponent(signature),
      responseContentType,
      responseContentDisposition,
      generation,
    ].join(''));
  });
};

module.exports = File;
