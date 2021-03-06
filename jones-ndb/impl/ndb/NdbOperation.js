/*
 Copyright (c) 2013, 2015 Oracle and/or its affiliates. All rights
 reserved.
 
 This program is free software; you can redistribute it and/or
 modify it under the terms of the GNU General Public License
 as published by the Free Software Foundation; version 2 of
 the License.
 
 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 GNU General Public License for more details.
 
 You should have received a copy of the GNU General Public License
 along with this program; if not, write to the Free Software
 Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
 02110-1301  USA
 */

"use strict";

/* This corresponds to OperationCodes */
var op_stats = { 
  "read"            : 0,
  "insert"          : 0,
  "update"          : 0,
  "write"           : 0,
  "delete"          : 0,
  "scan"            : 0,
  "scan_read"       : 0,
  "scan_count"      : 0,
  "scan_delete"     : 0,
  "projection_read" : 0
};

var index_stats = {};

var path          = require("path"),
    assert        = require("assert"),
    conf          = require("./path_config"),
    adapter       = require(conf.binary).ndb,
    doc           = require(jones.spi_doc.DBOperation),
    stats_module  = require(jones.api.stats),
    QueuedAsyncCall = require(jones.common.QueuedAsyncCall).QueuedAsyncCall,
    prepareFilterSpec = require("./NdbScanFilter.js").prepareFilterSpec,
    getIndexBounds = require(jones.common.IndexBounds).getIndexBounds,
    markQuery     = require(jones.common.IndexBounds).markQuery,
    bufferForText = adapter.impl.bufferForText,
    textFromBuffer = adapter.impl.textFromBuffer,
    COMMIT        = adapter.ndbapi.Commit,
    NOCOMMIT      = adapter.ndbapi.NoCommit,
    ROLLBACK      = adapter.ndbapi.Rollback,
    constants     = adapter.impl,
    OpHelper      = constants.OpHelper,
    ScanHelper    = constants.Scan.helper,
    BoundHelper   = constants.IndexBound.helper,
    opcodes       = doc.OperationCodes,
    NdbProjection = require("./NdbProjection"),
    udebug        = unified_debug.getLogger("NdbOperation.js");

stats_module.register(op_stats, "spi","ndb","DBOperation","created");
stats_module.register(index_stats, "spi","ndb","key_access");
stats_module.register(adapter.impl.encoder_stats, "spi","ndb","encoder");

var storeNativeConstructorInMapping;

var DBResult = function() {
  this.success   = null;
  this.error     = null;
  this.value     = null;
  this.insert_id = null;
};

// DBOperationError
var errorClassificationMap = {
  "ConstraintViolation" : "23000",
  "NoDataFound"         : "02000",
  "UnknownResultError"  : "08000"
};

var sqlStateMessages = { 
  "22000" : "Data error",
  "22001" : "String too long",
  "22003" : "Numeric value out of range",
  "22007" : "Invalid datetime",
  "23000" : "Column cannot be null",
  "HY000" : "Incorrect numeric value",
  "0F001" : "Invalid BLOB value",
  "WCTOR" : 
      "A Domain Object Constructor has overwritten persistent properties "+
      "that were read from the database.  The Domain Object Constructor "+
      "is called with no arguments and its ``this'' parameter set to the "+
      "newly read object."
};


function DBOperationError() {
  this.message   = "";
  this.ndb_error = null;
}

DBOperationError.prototype = {
  sqlstate       : "NDB00",
  cause          : null
};

DBOperationError.prototype.fromNdbError = function(ndb_error) {
  this.message   = ndb_error.message + " [" + ndb_error.code + "]";
  this.sqlstate  = errorClassificationMap[ndb_error.classification];
  this.ndb_error = ndb_error;
  return this;
};

DBOperationError.prototype.fromSqlState = function(sqlstate) {
  this.message = sqlStateMessages[sqlstate];
  this.sqlstate = sqlstate;
  return this;
};
  
DBOperationError.prototype.cascading = function(cause) {
  udebug.log("Adding indirect error from", cause);
  this.message = "Cascading Error";
  this.sqlstate = cause.sqlstate;
  this.cause = cause;
  return this;
};


function keepIndexStatistics(dbTable, index) {
  var i, idxStats, keyName;
    
	if(typeof index_stats[dbTable.name] === 'undefined') {
    idxStats = { "PrimaryKey" : 0 };
    for(i = 1 ; i < dbTable.indexes.length ; i++) {
      idxStats[dbTable.indexes[i].name] = 0;
    }
    index_stats[dbTable.name] = idxStats;
  }

	keyName = (index.isPrimaryKey ? "PrimaryKey" : index.name);
	index_stats[dbTable.name][keyName]++;
}  

// FIXME: Use tableHandler.resultRecord or dbTable.record as appropriate

var DBOperation = function(opcode, tx, indexHandler, tableHandler) {
  assert(tx);
 
  this.opcode         = opcode;
  this.userCallback   = null;
  this.transaction    = tx;
  this.keys           = {}; 
  this.values         = {};
  this.lockMode       = "";
  this.result         = new DBResult();
  this.indexHandler   = indexHandler;   
  if(indexHandler) { 
    this.tableHandler = indexHandler.tableHandler; 
    this.index        = indexHandler.dbIndex;
    keepIndexStatistics(this.tableHandler.dbTable, this.index);
  }      
  else {
    this.tableHandler = tableHandler;
    this.index        = null;  
  }
  
  /* NDB Impl-specific properties */
  this.encoderError = null;
  this.query        = null;
  this.scanOp       = null;
  this.needAutoInc  = false;
  this.buffers      = { 'row' : null, 'key' : null  };
  this.columnMask   = [];
  this.scan         = {};
  this.blobs        = null;

  op_stats[opcodes[opcode]]++;
};

function allocateKeyBuffer(op) {
  assert(op.buffers.key === null);
  op.buffers.key = new Buffer(op.index.record.getBufferSize());	
}

function releaseKeyBuffer(op) {
  if(op.opcode !== 2) {  /* all but insert use a key */
    op.buffers.key = null;
  }
}

/* If an error occurs while encoding, 
   encodeFieldsInBuffer() returns a DBOperationError
*/
function encodeFieldsInBuffer(fields, nfields, metadata, 
                              record, buffer, definedColumnList) {
  var i, column, value, encoderError, error;
  error = null;

  function addError() {
    udebug.log("encoderWrite error:", encoderError);
    if(error) {   // More than one column error, so use the generic code
      error.sqlstate = "22000"; 
      error.message += "; [" + column.name + "]";
    } else {
      error = new DBOperationError().fromSqlState(encoderError);
      error.message += " [" + column.name + "]";
    }
  }

  /* encodeFieldsInBuffer starts here */
  for(i = 0 ; i < nfields ; i++) {
    column = metadata[i];
    value = fields[i];
    if(typeof value !== 'undefined') {
      definedColumnList.push(column.columnNumber);
      if(value === null) {
        if(column.isNullable) {  record.setNull(i, buffer);        } 
        else                  {  encoderError = "23000"; addError();  }
      } 
      else {
        if(column.typeConverter && column.typeConverter.ndb) {
          value = column.typeConverter.ndb.toDB(value);
        }
        encoderError = record.encoderWrite(i, buffer, value);
        if(encoderError) { addError(); }
      }
    }
  }
  return error;
}


function encodeKeyBuffer(op) {
  var oneCol = op.indexHandler.singleColumn;  // single-column index
  if(oneCol && op.keys[0]) {  // ... and value is not undefined or null
    return op.index.record.encoderWrite(0, op.buffers.key, op.keys[0]);
  }
  return encodeFieldsInBuffer(op.keys, 
                              op.indexHandler.getMappedFieldCount(),
                              op.indexHandler.getColumnMetadata(),
                              op.index.record,
                              op.buffers.key, []);
}


function defineBlobs(nfields, metadata, values) {
  var i, blobs, col;
  blobs = [];
  for(i = 0 ; i < nfields ; i++) {
    col = metadata[i];
    if(col.isLob) {
      blobs[i] = col.isBinary ? values[i] : bufferForText(col, values[i]) ;
    }
  }
  return blobs;
}

function allocateRowBuffer(op) {
  assert(op.buffers.row === null);
  op.buffers.row = new Buffer(op.tableHandler.dbTable.record.getBufferSize());
}  

function releaseRowBuffer(op) {
  op.buffers.row = null;
}

function encodeRowBuffer(op) {
  udebug.log("encodeRowBuffer");
  var valuesArray = op.tableHandler.getFields(op.values);
  var nfields = op.tableHandler.getMappedFieldCount();
  var columnMetadata = op.tableHandler.getColumnMetadata();

  if(op.tableHandler.numberOfLobColumns) {
    op.blobs = defineBlobs(nfields, columnMetadata, valuesArray);
  }

  return encodeFieldsInBuffer(valuesArray,
                              nfields,
                              columnMetadata,
                              op.tableHandler.dbTable.record,
                              op.buffers.row,
                              op.columnMask);                    
}

function HelperSpec() {
  this.clear();
}

HelperSpec.prototype.clear = function() {
  this[0] = null;  // row_buffer
  this[1] = null;  // key_buffer
  this[2] = null;  // row_record
  this[3] = null;  // key_record
  this[4] = null;  // lock_mode
  this[5] = null;  // column_mask
  this[6] = null;  // value_obj
  this[7] = null;  // opcode
  this[8] = null;  // is_value_obj
  this[9] = null;  // blobs
  this[10] = null; // is_valid
};

var helperSpec = new HelperSpec();

function ScanHelperSpec() {
  this.clear();
}

ScanHelperSpec.prototype.clear = function() {
  this[ScanHelper.table_record] = null;
  this[ScanHelper.index_record] = null;
  this[ScanHelper.lock_mode]    = null;
  this[ScanHelper.bounds]       = null;
  this[ScanHelper.flags]        = 0;
  this[ScanHelper.batch_size]   = null;
  this[ScanHelper.parallel]     = null;
  this[ScanHelper.filter_code]  = null;
};

var scanSpec = new ScanHelperSpec();

function BoundHelperSpec() {
  this[BoundHelper.low_key]        = null;
  this[BoundHelper.low_key_count]  = 0;
  this[BoundHelper.low_inclusive]  = true;
  this[BoundHelper.high_key]       = null;
  this[BoundHelper.high_key_count] = 0;
  this[BoundHelper.high_inclusive] = true;
  this[BoundHelper.range_no]       = 0;
}

/* Create part of of a bound spec 
*/
BoundHelperSpec.prototype.buildPartialSpec = function(base, bound,
                                                      dbIndexHandler, buffer) {
  var nparts, err, columns;
  columns = dbIndexHandler.getColumnMetadata();
  err = null;

  /* count finite key parts.
     IndexBounds has assumed all columns are nullable, so we may have to
     transform a NULL bound to a -Infinity.
  */
  for(nparts = 0 ; nparts < bound.key.length; nparts++) {
    if((bound.key[nparts] == Infinity)  ||
       (bound.key[nparts] == -Infinity) ||
       (bound.key[nparts] === null && ! columns[nparts].isNullable))
    {
       break;
    }
  }
  if(nparts > 0) {
    err = encodeFieldsInBuffer(bound.key, nparts, columns,
                               dbIndexHandler.dbIndex.record, buffer, []);
  }
  udebug.log("Encoded", nparts, "parts for", (base ? "high" : "low"), "bound");

  this[base]     = (nparts > 0 ? buffer : null);
  this[base + 1] = nparts;
  this[base + 2] = bound.inclusive;
  return err;
};

BoundHelperSpec.prototype.setLow = function(bound, dbIndexHandler, buffer) {
  return this.buildPartialSpec(BoundHelper.low_key, bound.low, dbIndexHandler, buffer);
};

BoundHelperSpec.prototype.setHigh = function(bound, dbIndexHandler, buffer) {
  return this.buildPartialSpec(BoundHelper.high_key, bound.high, dbIndexHandler, buffer);
};


/* Takes an array of IndexBounds;
   Returns an array of BoundHelpers which will be used to build NdbIndexBounds.
   Builds a buffer of encoded parameters used in index bounds and 
   stores a reference to it in op.scan.
*/
DBOperation.prototype.buildBoundHelpers = function(indexBounds) {
  var dbIndexHandler, bound, sz, n, helper, allHelpers, mainBuffer, offset, i;
  dbIndexHandler = this.indexHandler;
  sz = dbIndexHandler.dbIndex.record.getBufferSize();
  n  = indexBounds.length;
  if(sz && n) {
    allHelpers = [];
    mainBuffer = new Buffer(sz * n * 2);
    offset = 0;
    this.scan.bound_param_buffer = mainBuffer; // maintain a reference!
    for(i = 0 ; i < n ; i++) {
      bound = indexBounds[i];
      helper = new BoundHelperSpec();
      helper.setLow(bound, dbIndexHandler, mainBuffer.slice(offset, offset+sz));
      offset += sz;
      helper.setHigh(bound, dbIndexHandler, mainBuffer.slice(offset, offset+sz));
      offset += sz;
      helper[BoundHelper.range_no] = i;  
      allHelpers.push(helper);
    }
  }
  
  this.scan.index_bound_helpers = allHelpers;  // maintain a reference 
  return allHelpers;
};


DBOperation.prototype.buildOpHelper = function(helper) {
  var code = this.opcode;
  var isVOwrite = (this.values && adapter.impl.isValueObject(this.values));
  var error = null;

  /* All operations but insert use a key. */
  if(code !== 2) {
    allocateKeyBuffer(this);
    encodeKeyBuffer(this);
    helper[OpHelper.key_record]  = this.index.record;
    helper[OpHelper.key_buffer]  = this.buffers.key;
  }
  
  /* If this is an update-after-read operation on a Value Object, 
     DBOperationHelper only needs the VO.
  */
  if(isVOwrite) {
    error = adapter.impl.prepareForUpdate(this.values);
    if(error) {
      this.encoderError = new DBOperationError().fromSqlState(error);
    } else {
      helper[OpHelper.value_obj] = this.values;
    }
  }  
  else {
    /* All non-VO operations get a row record */
    helper[OpHelper.row_record] = this.tableHandler.dbTable.record;
    
    /* All but delete get an allocated row buffer, and column mask */
    if(code !== 16) {
      allocateRowBuffer(this);
      helper[OpHelper.row_buffer]  = this.buffers.row;
      helper[OpHelper.column_mask] = this.columnMask;

      /* Read gets a lock mode, and possibly a blobs array.
         writes get the data encoded into the row buffer. */
      if(code === 1) {
        helper[OpHelper.lock_mode]  = constants.LockModes[this.lockMode];
        if(this.tableHandler.numberOfLobColumns) {
          this.blobs = [];
        }
      }
      else { 
        this.encoderError = encodeRowBuffer(this);
      }
    }
  }

  helper[OpHelper.opcode]       = code;
  helper[OpHelper.is_value_obj] = isVOwrite;
  helper[OpHelper.blobs]        = this.blobs;
  helper[OpHelper.is_valid]     = this.encoderError ? false : true;
};


function prepareOperations(dbTransactionContext, dbOperationList, recycleWrapper) {
  assert(dbTransactionContext);
  var n, length, specs;
  length = dbOperationList.length;
  if(length == 1) {
    specs = [ helperSpec ];  /* Reuse the global helperSpec */
    helperSpec.clear();
    dbOperationList[0].buildOpHelper(helperSpec);
  }
  else {
    specs = new Array(length);
    for(n = 0 ; n < dbOperationList.length ; n++) {
      specs[n] = new HelperSpec();
      dbOperationList[n].buildOpHelper(specs[n]);
    }
  }
  return adapter.impl.DBOperationHelper(length, specs, dbTransactionContext, recycleWrapper);
}


/* Prepare a scan operation.
   This produces the scan filter and index bounds, and then a ScanOperation,
   which is returned back to NdbTransactionHandler for execution.
*/
DBOperation.prototype.prepareScan = function(dbTransactionContext) {
  var indexBounds = null;
  var execQueue = this.transaction.dbSession.execQueue;
  var scanHelper, boundsHelpers, dbIndex, skipFilterForTesting;
 
  /* There is one global ScanHelperSpec */
  scanSpec.clear();

  scanSpec[ScanHelper.table_record] = this.query.dbTableHandler.dbTable.record;

  if(this.query.queryType == 2) {  /* Index Scan */
    dbIndex = this.query.dbIndexHandler.dbIndex;
    scanSpec[ScanHelper.index_record] = dbIndex.record;
    indexBounds = getIndexBounds(this.query, dbIndex, this.params);
    udebug.log("index bounds:", indexBounds.length);
    if(indexBounds.length) {
      boundsHelpers = this.buildBoundHelpers(indexBounds);
      scanSpec[ScanHelper.bounds] = [];
      if(indexBounds.length > 1) {
        scanSpec[ScanHelper.flags] |= constants.Scan.flags.SF_MultiRange;
      }
      boundsHelpers.forEach(function(helper) {
        var b = adapter.impl.IndexBound.create(helper);
        scanSpec[ScanHelper.bounds].push(b);
      });
    }
  }

  scanSpec[ScanHelper.lock_mode] = constants.LockModes[this.lockMode];

  if(this.params.order !== undefined) {
    scanSpec[ScanHelper.flags] |= constants.Scan.flags.SF_OrderBy;
    if(this.params.order.toLocaleLowerCase() == 'desc') {
      scanSpec[ScanHelper.flags] |= constants.Scan.flags.SF_Descending;
    }
  }

  skipFilterForTesting = false;
  if(this.query.ndbFilterSpec && ! skipFilterForTesting) {
    scanSpec[ScanHelper.filter_code] =
      this.query.ndbFilterSpec.getScanFilterCode(this.params);
    this.scan.filter = scanSpec[ScanHelper.filter_code];
    udebug.log("Using Scan Filter");
  }
  udebug.log("Flags", scanSpec[ScanHelper.flags]);
  this.scanOp = adapter.impl.Scan.create(scanSpec, 33, dbTransactionContext);
  return this.scanOp; 
};

DBOperation.prototype.isQueryOperation = function() {
  return (this.opcode == 97);
};

DBOperation.prototype.isScanOperation = function() {
  return (this.opcode >= 32);
};


function readResultRow(op) {
  udebug.log("readResultRow");
  var i, value;
  var dbt             = op.tableHandler;
  var record          = dbt.dbTable.record;
  var nfields         = dbt.getMappedFieldCount();
  var col             = dbt.getColumnMetadata();
  var resultRow       = dbt.newResultObject();
  
  for(i = 0 ; i < nfields ; i++) {
    if(col[i].isLob) {
      value = col[i].isBinary ? op.blobs[i] : textFromBuffer(col[i], op.blobs[i]);
    } else if(record.isNull(i, op.buffers.row)) {
      value = null;
    } else {
      value = record.encoderRead(i, op.buffers.row);
      if(col[i].typeConverter && col[i].typeConverter.ndb) {
        value = col[i].typeConverter.ndb.fromDB(value);
      }
    }

    dbt.set(resultRow, i, value);
  }
  op.result.value = resultRow;
}


function buildValueObject(op, tableHandler, buffer, blobs) {
  udebug.log("buildValueObject");
  var VOC = tableHandler.ValueObject; // NDB Value Object Constructor
  var DOC = tableHandler.newObjectConstructor;  // User's Domain Object Ctor
  var nWritesPre, nWritesPost, err, value;
  
  if(VOC) {
    /* Turn the buffer into a Value Object */
    value = new VOC(buffer, blobs);

    /* TODO: Apply type converters here, rather than in Column Handler??? */

    /* DBT may have some fieldConverters for this object */
    op.tableHandler.applyFieldConverters(value);

    /* Finally the user's constructor is called on the new value: */
    if(DOC) {
      nWritesPre = adapter.impl.getValueObjectWriteCount(value);
      DOC.call(value);
      nWritesPost = adapter.impl.getValueObjectWriteCount(value);
      if(nWritesPost > nWritesPre) {
        op.result.error = new DBOperationError().fromSqlState("WCTOR");
        op.result.success = false;
      }
    }
  }
  else {
    /* If there is a good reason to have no VOC, just call readResultRow()... */
    console.log("NO VOC!");
    process.exit();
  }

  return value;
}


function getScanResults(scanop, userCallback) {
  var buffer,results,dbSession,postScanCallback,nSkip,maxRow,i,recordSize;
  dbSession = scanop.transaction.dbSession;
  postScanCallback = {
    fn  : userCallback,
    arg0: null,
    arg1: null  
  };
  i = 0;
  nSkip = 0;
  maxRow = 100000000000;
  if(scanop.params) {
    if(scanop.params.skip > 0)   { nSkip = scanop.params.skip;           }
    if(scanop.params.limit >= 0) { maxRow = nSkip + scanop.params.limit; }
  }
  if(udebug.is_debug()) {
    udebug.log("skip", nSkip, "+ limit", scanop.params.limit, "=", maxRow);
  }

  recordSize = scanop.tableHandler.dbTable.record.getBufferSize();

  function fetchResults(dbSession, ndb_scan_op, buffer) {
    var apiCall = new QueuedAsyncCall(dbSession.execQueue, null);
    var force_send = true;
    apiCall.preCallback = gather;
    apiCall.ndb_scan_op = ndb_scan_op;
    apiCall.description = "fetchResults" + scanop.transaction.moniker + i;
    apiCall.buffer = buffer;
    apiCall.run = function runFetchResults() {
      this.ndb_scan_op.fetchResults(this.buffer, force_send, this.callback);
    };
    apiCall.enqueue();
    i++;
  }

  function pushNewResult() {
    var blobs, result;
    blobs = scanop.scanOp.readBlobResults();
    udebug.log("pushNewResult",i,blobs);
    result = buildValueObject(scanop, scanop.tableHandler, buffer, blobs);
    results.push(result);
  }

  function fetch() {
    buffer = new Buffer(recordSize);
    fetchResults(dbSession, scanop.scanOp, buffer);  // gather() is the callback
  }

  /* <0: ERROR, 0: RESULTS_READY, 1: SCAN_FINISHED, 2: CACHE_EMPTY */
  /* gather runs as a preCallback */
  function gather(error, status) {    
    udebug.log("gather() status", status);

    if(status < 0) { // error
      if(udebug.is_debug()) udebug.log("gather() error", error);
      postScanCallback.arg0 = error;
      return postScanCallback;
    }
    
    /* Gather more results. */
    while(status === 0 && results.length < maxRow) {
      pushNewResult();
      buffer = new Buffer(recordSize);
      status = scanop.scanOp.nextResult(buffer);
    }
    
    if(status == 2 && results.length < maxRow) {    // Cache empty
      fetch();
    }
    else {  // end of scan.
      /* Now remove the rows that should have been skipped 
         (fixme: do something more efficient) */
      for(i = 0 ; i < nSkip ; i++) results.shift();

      udebug.log("gather() 1 End_Of_Scan.  Final length:", results.length);
      scanop.result.success = true;
      scanop.result.value = results;
      postScanCallback.arg1 = results;
      return postScanCallback;
    }    
  }

  /* start here */
  results = [];
  fetch();
}

function getQueryResults(op, userCallback) {
  var i = 0;
  var sectors = [];
  var ndbProjection = op.query;

  while(ndbProjection) {
    sectors[i++] = ndbProjection;
    ndbProjection = ndbProjection.next;
  }

  op.scanOp.fetchAllResults(function(err, nresults) {
    var i, wrapper, level, current, resultObject, related;
    current = [];   // current values for each sector
    current[0] = null;
    wrapper = {};

    function assemble() {
      current[level] = resultObject;
      if(level > 0) {
        related = sectors[level].relatedField;
        if(related.toMany && ! current[level-1][related.fieldName])
        {
          current[level-1][related.fieldName] = [];
        }
        if(related.toMany) {
          current[level-1][related.fieldName].push(resultObject);
        } else {
          current[level-1][related.fieldName] = resultObject;
        }
      }
    }

    function assembleSpecial(tag) {
      if(tag & 2) {   /* This row came from a many-to-many join table but
                         is not itself part of the user's result object.  */
        current[level] = current[level - 1];
      }
      if(tag & 1) {   /* Row is null */
        current[level] = null;
        if(level > 0) {
          related = sectors[level].relatedField || sectors[level-1].relatedField;
          if(related.toMany && ! current[level-1][related.fieldName]) {
            current[level-1][related.fieldName] = [];
          }
          else {
            current[level-1][related.fieldName] = null;
          }
        }
      }
    }

    udebug.log("fetchAllResults returns", err, nresults);
    if(err) {
      op.result.success = false;
      op.result.error = new DBOperationError().fromNdbError(err);
    } else {
      for(i = 0 ; i < nresults ; i++) {
        op.scanOp.getResult(i, wrapper);
        udebug.log("Wrapper",wrapper.level,wrapper.tag);
        level = wrapper.level;
        if(wrapper.tag) {
          assembleSpecial(wrapper.tag);
        } else {
          resultObject = buildValueObject(op, sectors[level].tableHandler,
                                          wrapper.data, null);
          assemble();
        }
      }
      op.result.success = true;
      op.result.value = current[0];
    }
    udebug.log("Join result:", current[0]);
    userCallback(err, op.result.value);
  });
}

function buildOperationResult(transactionHandler, op, op_ndb_error, execMode) {
  udebug.log("buildOperationResult");

  /* Summarize Operation Error */
  if(op.encoderError) {
    udebug.log("Operation has encoder error");
    op.result.success = false;
    op.result.error = op.encoderError;
  } else if(op_ndb_error === null) {
    op.result.success = true;
  } else {
    op.result.success = false;
    if(op_ndb_error !== true) {  // TRUE here means NdbOperation is null
      op.result.error = new DBOperationError().fromNdbError(op_ndb_error);
    }
  }

  /* Handle Transaction Error */
  if(execMode !== ROLLBACK) {
    if(op.result.success) {
      if(transactionHandler.error) {
        /* This operation has no error, but the transaction failed. */
        udebug.log("Case txErr + opOK", transactionHandler.moniker);
        op.result.success = false;
        op.result.error = new DBOperationError().cascading(transactionHandler.error);
      }
    }
    else {
      /* This operation has an error. */
      if(transactionHandler.error) {
        udebug.log("Case txErr + OpErr", transactionHandler.moniker);
      }
      else {
        if(op.opcode === opcodes.OP_READ || execMode === NOCOMMIT) {
          udebug.log("Case txOK + OpErr [READ | NOCOMMIT]", transactionHandler.moniker);
        }
        else {
          udebug.log("Case txOK + OpErr", transactionHandler.moniker);
          transactionHandler.error = new DBOperationError().cascading(op.result.error);
        }
      }
    }

    if(op.result.success && op.opcode === opcodes.OP_READ) {
      op.result.value = buildValueObject(op, op.tableHandler, op.buffers.row, op.blobs);
    } 
  }
  if(udebug.is_detail()) udebug.log("buildOperationResult finished:", op.result);
}

function completeExecutedOps(dbTxHandler, execMode, operations) {
  /* operations is an object: 
     {
        "operationList"       : operationList,
        "pendingOperationSet" : pendingOpsSet
      };
  */
  if(udebug.is_debug()) udebug.log("completeExecutedOps mode:", execMode,
                        "operations: ", operations.operationList.length);
  var n, op, op_err;
  for(n = 0 ; n < operations.operationList.length ; n++) {
    op = operations.operationList[n];

    if(! op.isScanOperation()) {
      op_err = operations.pendingOperationSet.getOperationError(n);
      releaseKeyBuffer(op);
      op.blobs = operations.pendingOperationSet.readBlobResults(n);
      buildOperationResult(dbTxHandler, op, op_err, execMode);
      releaseRowBuffer(op);
    }

    dbTxHandler.executedOperations.push(op);
    if(typeof op.userCallback === 'function') {
      op.userCallback(op.result.error, op);
    }
  }
  udebug.log("completeExecutedOps done");
}


storeNativeConstructorInMapping = function(dbTableHandler) {
  var i, nfields, record, fieldNames, typeConverters;
  var VOC, DOC;  // Value Object Constructor, Domain Object Constructor
  if(dbTableHandler.ValueObject) { 
    return;
  }
  /* Step 1: Create Record
     getRecordForMapping(table, ndb, nColumns, columns array)
  */
  nfields = dbTableHandler.getNumberOfColumns();
  record = adapter.impl.DBDictionary.getRecordForMapping(
    dbTableHandler.dbTable,
    dbTableHandler.dbTable.per_table_ndb,
    nfields,
    dbTableHandler.getAllColumns()
  );

  /* Step 2: Get NdbRecordObject Constructor
    getValueObjectConstructor(record, fieldNames, typeConverters)
  */
  fieldNames = {};
  typeConverters = {};
  for(i = 0 ; i < nfields ; i++) {
    fieldNames[i] = dbTableHandler.getResolvedMapping().fields[i].fieldName;
    typeConverters[i] = dbTableHandler.getColumn(i).typeConverter.ndb;
  }

  VOC = adapter.impl.getValueObjectConstructor(record, fieldNames, typeConverters);

  /* Apply the user's prototype */
  DOC = dbTableHandler.newObjectConstructor;
  if(DOC && DOC.prototype) {
    VOC.prototype = DOC.prototype;
  }

  /* Store both the VOC and the Record in the mapping */
  dbTableHandler.ValueObject = VOC;
  dbTableHandler.resultRecord = record;
};

function verifyIndexHandler(dbIndexHandler) {
  if(! dbIndexHandler.tableHandler) { throw ("Invalid dbIndexHandler"); }
}

function newReadOperation(tx, dbIndexHandler, keys, lockMode) {
  verifyIndexHandler(dbIndexHandler);
  var op = new DBOperation(opcodes.OP_READ, tx, dbIndexHandler, null);
  op.keys = Array.isArray(keys) ? keys : dbIndexHandler.getFields(keys);

  if(! dbIndexHandler.tableHandler.ValueObject) {
    storeNativeConstructorInMapping(dbIndexHandler.tableHandler);
  }

  assert(doc.LockModes.indexOf(lockMode) !== -1);
  if(op.index.isPrimaryKey || lockMode === "EXCLUSIVE") {
    op.lockMode = lockMode;
  }
  else {
    op.lockMode = "SHARED";
  }
  return op;
}


function newProjectionOperation(sessionImpl, tx, indexHandler, keys, projection) {
  var op, ndbProjection, depth;
  op = new DBOperation(opcodes.OP_PROJ_READ, tx, indexHandler, null);

  /* Encode keys for operation */
  op.keys = Array.isArray(keys) ? keys : indexHandler.getFields(keys);
  allocateKeyBuffer(op);
  encodeKeyBuffer(op);

  /* Create Value Object Constructors for all tables */
  projection.sectors.forEach(function(sector) {
    storeNativeConstructorInMapping(sector.tableHandler);
  });

  /* Create an NdbProjection, then use it to create a QueryOperation */
  ndbProjection = NdbProjection.initialize(projection.sectors, indexHandler);
  op.query = ndbProjection.root;
  depth = ndbProjection.depth + 1;
  op.scanOp = adapter.impl.QueryOperation.create(op.query, op.buffers.key, depth);
  return op;
}


function newInsertOperation(tx, tableHandler, row) {
  var op = new DBOperation(opcodes.OP_INSERT, tx, null, tableHandler);
// Test row for VO?
  op.values = row;
  if (typeof row[op.tableHandler.autoIncFieldName] === 'undefined') {
    // we need autoincrement services because the user did not supply the value for the autoincrement column
    op.needAutoInc = true;
  }
  return op;
}


function newDeleteOperation(tx, dbIndexHandler, keys) {
  verifyIndexHandler(dbIndexHandler);
  var op = new DBOperation(opcodes.OP_DELETE, tx, dbIndexHandler, null);
  op.keys = dbIndexHandler.getFields(keys);
  return op;
}


function newWriteOperation(tx, dbIndexHandler, row) {
  verifyIndexHandler(dbIndexHandler);
  var op = new DBOperation(opcodes.OP_WRITE, tx, dbIndexHandler, null);
// Test row for VO
  op.keys = dbIndexHandler.getFields(row);
  op.values = row;
  return op;
}


function newUpdateOperation(tx, dbIndexHandler, keys, row) {
  verifyIndexHandler(dbIndexHandler);
  var op = new DBOperation(opcodes.OP_UPDATE, tx, dbIndexHandler, null);
  op.keys = dbIndexHandler.getFields(keys);
  op.values = row;
  return op;
}


function newScanOperation(tx, QueryTree, properties) {
  var queryHandler = QueryTree.jones_query_domain_type.queryHandler;
  var op = new DBOperation(opcodes.OP_SCAN, tx, 
                           queryHandler.dbIndexHandler, 
                           queryHandler.dbTableHandler);
  prepareFilterSpec(queryHandler);  // sets query.ndbFilterSpec
  op.query = queryHandler;
  op.params = properties;
  if(! queryHandler.dbTableHandler.ValueObject) {
    storeNativeConstructorInMapping(queryHandler.dbTableHandler);
  }
  return op;
}


exports.DBOperation         = DBOperation;
exports.DBOperationError    = DBOperationError;
exports.newReadOperation    = newReadOperation;
exports.newInsertOperation  = newInsertOperation;
exports.newDeleteOperation  = newDeleteOperation;
exports.newUpdateOperation  = newUpdateOperation;
exports.newWriteOperation   = newWriteOperation;
exports.newScanOperation    = newScanOperation;
exports.newProjectionOperation = newProjectionOperation;
exports.completeExecutedOps = completeExecutedOps;
exports.getScanResults      = getScanResults;
exports.prepareOperations   = prepareOperations;
exports.getQueryResults     = getQueryResults;
