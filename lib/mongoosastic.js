var elasticsearch = require('elasticsearch')
	, generator = new (require('./mapping-generator'))
	, serialize = require('./serialize')
	, events = require('events')
	, mongoose = require('mongoose')
	, async = require('async')
	, nop = require('nop')
	, esClient

function Mongoosastic(schema, options) {
	var mapping = getMapping(schema)
		, indexName = options && options.index
		, typeName = options && options.type
		, alwaysHydrate = options && options.hydrate
		, defaultHydrateOptions = options && options.hydrateOptions
		, bulk = options.bulk
		, bulkBuffer = []
		, bulkTimeout
	
	this.esClient = this.esClient || new elasticsearch.Client({
		host: options.host || "localhost:9200",
		apiVersion:options.apiVersion || '1.0'
	});
	esClient = this.esClient;
	setUpMiddlewareHooks(schema)

	/**
	 * ElasticSearch Client
	 */
	schema.statics.esClient = esClient

	/**
	 * Create the mapping. Takes an optionnal settings parameter and a callback that will be called once
	 * the mapping is created

	 * @param settings Object (optional)
	 * @param callback Function
	 */
	schema.statics.createMapping = function (settings, cb) {
		if (arguments.length < 2) {
			cb = arguments[0] || nop
			settings = undefined
		}

		setIndexNameIfUnset(this.modelName)

		createMappingIfNotPresent({
			client: esClient,
			indexName: indexName,
			typeName: typeName,
			schema: schema,
			settings: settings
		}, cb)
	}

	/**
	 * @param options  Object (optional)
	 * @param callback Function
	 */
	schema.methods.index = function (options, cb) {
		var _this = this;
		if (arguments.length < 2) {
			cb = arguments[0] || nop
			options = {}
		}

		//自动匹配index与type
		setIndexNameIfUnset(this.constructor.modelName)
		var index = options.index || indexName
			, type = options.type || typeName
			,serialModel = serialize(this, mapping);
		createMappingIfNotPresent({
			client: esClient,
			indexName: index,
			typeName: type,
			schema: schema
		},function(err){
			if(err) throw err;
			if (bulk) {
				/**
				 * To serialize in bulk it needs the _id
				 */
				serialModel._id = _this._id;
				bulkIndex({
					index: index,
					type: type,
					model: serialModel
				})
				setImmediate(cb)
			} else {
				esClient.index({
					index: index,
					type: type,
					id: _this._id.toString(),
					body: serialModel
				}, cb)
			}

		});
	}

	/**
	 * Unset elastic search index
	 * @param options - (optional) options for unIndex
	 * @param callback - callback when unIndex is complete
	 */
	schema.methods.unIndex = function (options, cb) {
		if (arguments.length < 2) {
			cb = arguments[0] || nop
			options = {}
		}

		setIndexNameIfUnset(this.constructor.modelName)

		options.index = options.index || indexName
		options.type = options.type || typeName
		options.model = this
		options.client = esClient
		options.tries = 3

		if (bulk)
			bulkDelete(options, cb)
		else
			deleteByMongoId(options, cb)
	}

	/**
	 * Delete all documents from a type/index
	 * @param options - (optional) specify index/type
	 * @param callback - callback when truncation is complete
	 */
	schema.statics.esTruncate = function (options, cb) {
		if (arguments.length < 2) {
			cb = arguments[0] || nop
			options = {}
		}

		var index = options.index || indexName
			, type = options.type || typeName

		esClient.deleteByQuery({
			index: index,
			type: type,
			body: {
				query: {
					match_all: {}
				}
			}
		}, cb)
	}

	/**
	 * Synchronize an existing collection
	 *
	 * @param query - query for documents you want to synchronize
	 */
	schema.statics.synchronize = function (query) {
		var em = new events.EventEmitter()
			, closeValues = []
			, counter = 0
			, close = function () {
				em.emit.apply(em, ['close'].concat(closeValues))
			}

		//Set indexing to be bulk when synchronizing to make synchronizing faster
		bulk = bulk || {
			delay: 1000,
			size: 1000
		}

		query = query || {}

		setIndexNameIfUnset(this.modelName)

		var stream = this.find(query).stream()

		stream.on('data', function (doc) {
			counter++
			doc.save(function (err) {
				if (err)
					return em.emit('error', err)

				doc.on('es-indexed', function (err, doc) {
					counter--
					if (err) {
						em.emit('error', err)
					} else {
						em.emit('data', null, doc)
					}
				})
			})
		})

		stream.on('close', function (a, b) {
			closeValues = [a, b]
			var closeInterval = setInterval(function () {
				if (counter === 0 && bulkBuffer.length === 0) {
					clearInterval(closeInterval)
					close()
				}
			}, 1000)
		})

		stream.on('error', function (err) {
			em.emit('error', err)
		})

		return em
	}
	/**
	 * ElasticSearch search function
	 *
	 * @param query - query object to perform search with
	 * @param options - (optional) special search options, such as hydrate
	 * @param callback - callback called with search results
	 */
	schema.statics.search = function (query, options, cb) {
		if (arguments.length === 2) {
			cb = arguments[1]
			options = {}
		}

		if (query === null)
			query = undefined

		setIndexNameIfUnset(this.modelName)

		var model = this
			, esQuery = {
				body: {query: query},
				index: options.index || indexName,
				type: options.type || typeName
			}


		Object.keys(options).forEach(function (opt) {
			if (!opt.match(/hydrate/) && options.hasOwnProperty(opt))
				esQuery[opt] = options[opt]
		})

		esClient.search(esQuery, function (err, res) {
			if (err) {
				cb(err)
			} else {
				if (alwaysHydrate || options.hydrate) {
					hydrate(res,options.hydrateOptions || defaultHydrateOptions || {}, cb)
				} else {
					cb(null, res)
				}
			}
		})
	}

	function bulkDelete(options, cb) {
		bulkAdd({
			delete: {
				_index: options.index || indexName,
				_type: options.type || typeName,
				_id: options.model._id.toString()
			}
		})
		cb()
	}

	function bulkIndex(options) {
		bulkAdd({
			index: {
				_index: options.index || indexName,
				_type: options.type || typeName,
				_id: options.model._id.toString()
			}
		})
		bulkAdd(options.model)
	}

	function clearBulkTimeout() {
		clearTimeout(bulkTimeout)
		bulkTimeout = undefined
	}

	function bulkAdd(instruction) {
		bulkBuffer.push(instruction)

		//Return because we need the doc being indexed
		//Before we start inserting
		if (instruction.index && instruction.index._index)
			return

		if (bulkBuffer.length >= (bulk.size || 1000)) {
			schema.statics.flush()
			clearBulkTimeout()
		} else if (bulkTimeout === undefined) {
			bulkTimeout = setTimeout(function () {
				schema.statics.flush()
				clearBulkTimeout()
			}, bulk.delay || 1000)
		}
	}

	schema.statics.flush = function (cb) {
		cb = cb || function (err) {
			if (err) console.log(err)
		}

		esClient.bulk({
			body: bulkBuffer
		}, function (err) {
			cb(err)
		})
		bulkBuffer = []
	}

	schema.statics.refresh = function (options, cb) {
		if (arguments.length < 2) {
			cb = arguments[0] || nop
			options = {}
		}

		setIndexNameIfUnset(this.modelName)
		esClient.indices.refresh({
			index: options.index || indexName
		}, cb)
	}

	function setIndexNameIfUnset(model) {
		var modelName = model.toLowerCase()
		if (!indexName) {
			indexName = modelName + "s"
		}
		if (!typeName) {
			typeName = modelName
		}
	}


	/**
	 * Use standard Mongoose Middleware hooks
	 * to persist to Elasticsearch
	 */
	function setUpMiddlewareHooks(schema) {
		schema.post('remove', function () {
			setIndexNameIfUnset(this.constructor.modelName)

			var options = {
				index: indexName,
				type: typeName,
				tries: 3,
				model: this,
				client: esClient
			}

			if (bulk) {
				bulkDelete(options, nop)
			} else {
				deleteByMongoId(options, nop)
			}
		})

		/**
		 * Save in elastic search on save.
		 */
		schema.post('save', function () {
			var model = this

			model.index(function (err, res) {
				model.emit('es-indexed', err, res)
			})
		})
	}

}


module.exports = {
	mongoose:null,
	connect: function (options) {
		var host = options && options.host || 'localhost',
			port = options && options.port || 9200,
			protocol = options && options.protocol || 'http',
			auth = options && options.auth ? options.auth : null;

		this.esClient = this.esClient || new elasticsearch.Client({
			host: {
				host: host,
				port: port,
				protocol: protocol,
				auth: auth
			}
		});
	},
	suggest:function(query, options, cb){
		if (arguments.length === 2) {
			cb = arguments[1]
			options = {}
		}
		mongoose = this.mongoose || mongoose;
		if (query === null)
			query = undefined

		var esQuery = {
			body:query,
			index: options.index || "",
			type: options.type || ""
		};

		esClient.indices.exists({index: options.index},function(err,exists){
			if(!err){
				if(exists){
					esClient.suggest(esQuery, function (err, res) {
						if (err) {
							cb(err)
						} else {
							cb(null, res)
						}
					})
				} else {
					cb(null, {});
				}
			}
		});
	},
	/**
	 * 全局性的搜索，可以搜索多索引，多类型，同时也能hydrate
	 */
	search:function(query, options, cb){
		if (arguments.length === 2) {
			cb = arguments[1]
			options = {}
		}
		mongoose = this.mongoose || mongoose;
		if (query === null)
			query = undefined

		var esQuery = {
			body:query,
			index: options.index || "",
			type: options.type || ""
		};

		Object.keys(options).forEach(function (opt) {
			if (!opt.match(/hydrate/) && options.hasOwnProperty(opt))
				esQuery[opt] = options[opt]
		})

		esClient.indices.exists({index: options.index},function(err,exists){
			if(!err){
				if(exists){
					esClient.search(esQuery, function (err, res) {
						if (err) {
							cb(err)
						} else {
							if (options.hydrate) {
								hydrate(res,options || {}, cb)
							} else {
								cb(null, res)
							}
						}
					})
				} else {
					cb(null, {});
				}
			}
		});

	},
	plugin: function(options){
		var _this = this;
		options = options || {};
		options.host = options && options.host ? options.host : 'localhost:9200'
		options.apiVersion = options && options.apiVersion ? options.apiVersion : '1.0'
		return function(schema,_options){
			_options = _options || {};
			_this.options = extend(options,_options);
			return Mongoosastic(schema,_this.options);
		}
	}
};

function extend(target) {
	var src
	for (var i = 1, l = arguments.length; i < l; i++) {
		src = arguments[i]
		for (var k in src) target[k] = src[k]
	}
	return target
}

function createMappingIfNotPresent(options, cb) {
	var client = options.client
		, indexName = options.indexName
		, typeName = options.typeName
		, schema = options.schema
		, settings = options.settings

	generator.generateMapping(schema, function (err, mapping) {
		var completeMapping = {}
		completeMapping[typeName] = mapping
		client.indices.exists({index: indexName}, function (err, exists) {
			if (err)
				return cb(err)

			if (exists) {
				client.indices.putMapping({
					index: indexName,
					type: typeName,
					body: completeMapping
				}, cb)
			} else {
				client.indices.create({index: indexName, body: settings}, function (err) {
					if (err)
						return cb(err)
					client.indices.putMapping({
						index: indexName,
						type: typeName,
						body: completeMapping
					}, cb)
				})
			}
		})
	})
}

function hydrate(res,options, cb) {
	var results = res.hits
		, resultsMap = {}
		, ids = {}
		, querys = {}
		, hits = []
		, model
	results.hits.forEach(function(a,i){
		var modelName = getModelName(a);
		if(modelName) {
			resultsMap[modelName] = resultsMap[modelName] || {};
			ids[modelName] = ids[modelName] || [];
			resultsMap[modelName][a._id] = i;//记录排序索引
			ids[modelName].push(a._id);
		}
	});
	async.eachSeries(Object.keys(resultsMap),function(modelName,callback){
		model = mongoose.model(modelName);
		querys[modelName] = model.find({_id:{$in:ids[modelName]}});
		Object.keys(options.hydrateOptions).forEach(function (option) {
			querys[modelName][option](options.hydrateOptions[option])
		})
		querys[modelName].exec(function(err, docs){
			if (err) {
				return cb(err)
			} else {
				docs.forEach(function (doc) {
					var i = resultsMap[modelName][doc._id]
					hits[i] = Object.create(doc);
				});
				callback();
			}
		})
	},function(){
		results.hits = hits
		res.hits = results
		cb(null, res)
	});
}

function getModelName(es_item){
	if(!es_item || !es_item._type) return;
	var names = mongoose.modelNames(),
		res="";
	names.forEach(function(name){
		if(es_item._type === name.toLowerCase()){
			res = name;
			return false;
		}
	});
	return res;
}

function getMapping(schema) {
	var retMapping = {}
	generator.generateMapping(schema, function (err, mapping) {
		retMapping = mapping
	})
	return retMapping
}

function deleteByMongoId(options, cb) {
	var index = options.index
		, type = options.type
		, client = options.client
		, model = options.model
		, tries = options.tries

	client.delete({
		index: index,
		type: type,
		id: model._id.toString()
	}, function (err, res) {
		if (err && err.message.indexOf('404') > -1) {
			setTimeout(function () {
				if (tries <= 0) {
					return cb(err)
				} else {
					options.tries = --tries
					deleteByMongoId(options, cb)
				}
			}, 500)
		} else {
			model.emit('es-removed', err, res)
			cb(err)
		}
	})
}
