'use strict';

/**
 * CJS shim so silence-evernote-stdio can load the Evernote Thrift transport
 * relative to this package (works for global npm bin installs) without relying
 * on process.cwd()/argv or import.meta (Jest/ts-jest hostile).
 */
module.exports = require('evernote/lib/thrift/transport/binaryHttpTransport.js');
