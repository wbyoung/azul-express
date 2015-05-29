'use strict';

var _ = require('lodash');
var BPromise = require('bluebird');

/**
 * Setup a request object, adding azul functionality.
 *
 * @param {Database} db
 * @param {Request} req
 */
var setupRequest = function(db, req, options) {
  if (req.azul && req.azul.query) { return; } // already set up

  var opts = _.defaults({}, options, { transaction: false });
  var transaction;
  var query = db.query;
  if (opts.transaction) {
    transaction = db.query.transaction();
    query = query.transaction(transaction);
  }
  req.azul = _.extend({}, req.azul, {
    transaction: transaction,
    query: query,
  });
};

/**
 * Setup a response object, adding azul functionality.
 *
 * @param {Database} db
 * @param {Request} req
 * @param {Response} res
 * @param {Function} next
 */
var setupResponse = function(db, req, res, next) {
  if (!req.azul.transaction) { return; } // no setup required
  if (res.azul && res.azul.commit) { return; } // already set up

  var transaction = req.azul.transaction;
  var pending = []; // operations waiting until after commit/rollback
  var promise; // promise for close transaction (COMMIT/ROLLBACK)

  var runPending = function() {
    var array = pending.slice();
    pending = undefined;
    array.forEach(function(fn) {
      fn();
    });
  };

  var commit = function() {
    if (promise) { return promise; }
    promise = transaction.commit().execute().then(runPending).catch(next);
    return promise;
  };

  var rollback = function() {
    if (promise) { return promise; }
    promise = transaction.rollback().execute().then(runPending).catch(next);
    return promise;
  };

  var triggerCommit = function(fn) {
    return function() {
      if (pending) {
        pending.push(fn.apply.bind(fn, this, arguments));
        commit();
      }
      else {
        fn.apply(this, arguments);
      }
    };
  };

  res.writeHead = triggerCommit(res.writeHead);
  res.write = triggerCommit(res.write);
  res.end = triggerCommit(res.end);
  res.azul = _.extend({}, res.azul, {
    commit: commit,
    rollback: rollback,
  });
};

/**
 * Wrap a next function so that it performs a rollback on the transaction if
 * called with an error.
 *
 * @param {Database} db
 * @param {Request} req
 * @param {Response} res
 * @param {Function} next
 * @return {Function}
 */
var wrapNext = function(db, req, res, next) {
  return function() {
    var args = _.toArray(arguments);
    var promise = BPromise.resolve();
    if (!args[0] && res.azul) {
      promise = res.azul.commit();
    }
    else if ((args[0] instanceof Error) && res.azul) {
      promise = res.azul.rollback();
    }
    else if (args[0] && !(args[0] instanceof Error)) {
      throw new Error('Unexpected call to `next` with non-error.');
    }
    return promise.then(next.apply.bind(next, this, args)).catch(next);
  };
};

/**
 * Make transaction middleware for a specific database.
 *
 * @param {Database} db
 * @return {Function} The middleware.
 */
var transactionMiddleware = function(db) {
  return function(req, res, next) {
    setupRequest(db, req, { transaction: true });
    setupResponse(db, req, res, next);
    req.azul.transaction.begin().then(_.ary(next, 0), next);
  };
};

/**
 * Make error middleware. This assumes that the main middleware has already
 * been installed.
 *
 * @param {Database} db
 * @return {Function} The middleware.
 */
var rollbackMiddleware = function(/*db*/) {
  return function(err, req, res, next) {
    var promise = res.azul ? res.azul.rollback() : BPromise.resolve();
    promise.return(err).then(next).catch(next);
  };
};

/**
 * Make a standard route for express. Pass the original arguments followed by
 * req, res, next to the wrapped function.
 *
 * @param {Function} fn
 * @return {Function}
 */
var makeExpressStandardRoute = function(fn) {
  return function(req, res, next) {
    return fn.call(this, _.toArray(arguments), req, res, next);
  };
};

/**
 * Make an error route for express. Pass the original arguments followed by
 * req, res, next to the wrapped function.
 *
 * @param {Function} fn
 * @return {Function}
 */
var makeExpressErrorRoute = function(fn) {
  return function(err, req, res, next) {
    return fn.call(this, _.toArray(arguments), req, res, next);
  };
};

/**
 * Check if a value looks like a promise.
 *
 * @param {?} value
 * @return {Boolean}
 */
var isPromise = function(value) {
  return value && typeof value.then === 'function';
};

/**
 * Create a model class binder function.
 *
 * The resulting function should be called with the name of a model to bind. A
 * bound model will be created from that name. All relationships on that model
 * will also be bound properly. The result is a model that you can safely use
 * that has been bound to the query/transaction.
 *
 * @param {Database} db
 * @param {Request} req
 * @return {Function}
 */
var modelBinder = function(db, req) {
  var query = req.azul.query;
  var simple = !req.azul.transaction;
  var bound = {};
  var bind = function(/*name*/) {
    var name = arguments[0].toLowerCase();
    if (!bound[name] && simple) { bound[name] = db.model(name); }
    else if (!bound[name]) {
      var subclass = bound[name] = db.model(name).extend();
      var prototype = subclass.__class__.prototype;

      // create an override of each relation defined on the model with the
      // relation's model classes swapped out for bound models. note that no
      // re-configuration will occur for the relation objects. they'll simply
      // use a different model class when creating or accessing instances.
      _.keysIn(prototype).filter(function(key) {
        return key.match(/Relation$/);
      })
      .forEach(function(key) {
        // TODO: we're accessing protected variables on the relation here. it
        // would be a good idea to expose a tested method in the main azul
        // project that we're sure will exist.
        var relation = Object.create(prototype[key]); // copy relation
        relation._modelClass = bind(relation._modelClass.__name__);
        relation._relatedModel = bind(relation._relatedModel.__name__);
        Object.defineProperty(prototype, key, { // redefine property
          enumerable: true, get: function() { return relation; },
        });
      });

      // redefine the query object on this model class
      subclass.reopenClass({ query: query });
    }
    return bound[name];
  };
  return bind;
};

/**
 * A wrapper for Express routes that binds queries & model classes to the
 * transaction.
 *
 * @param {Database} db The Azul.js database on which bindings should be created.
 * @param {Function} fn The Express route to wrap.
 * @return {Function} The wrapped route.
 */
var route = function(db, fn, options) {
  var opts = _.defaults({}, options, {
    transaction: false
  });

  var match = fn.toString().match(/function.*?\((.*?)\)/i);
  if (!match) {
    throw new Error('Cannot create route for function: ' + fn.toString());
  }
  var params = _.invoke(match[1].split(','), 'trim');
  var isAzulParam = function(arg) { return arg.match(/^([A-Z]\w*|query)$/); };
  var isExpressParam = _.negate(isAzulParam);

  var expressParams = _(params)
    .takeWhile(isExpressParam)
    .value();

  var azulParams = _(params)
    .drop(expressParams.length)
    .takeWhile(isAzulParam)
    .value();

  if (expressParams.length + azulParams.length !== params.length) {
    throw new Error('Unexpected arguments: ' + params.join(', '));
  }

  // argument length is important to express
  var isErrorRoute = (expressParams.length === 4);
  var expressRoute = isErrorRoute ?
    makeExpressErrorRoute :
    makeExpressStandardRoute;

  return expressRoute(function(args, req, res, next) {
    var promise = BPromise.resolve();
    var begun = req.azul && req.azul.transaction;
    setupRequest(db, req, { transaction: opts.transaction });
    setupResponse(db, req, res, next);

    if (opts.transaction && !begun) {
      promise = req.azul.transaction.begin().execute().catch(next);
    }

    // wrap next now & all actions from this point forward should use the
    // wrapped version so that if a transaction is active, it will be rolled
    // back.
    next = wrapNext(db, req, res, next);

    // form express arguments
    var expressArgs = _.take(args, expressParams.length);
    if (expressArgs.length >= 3) {
      expressArgs.splice(-1, 1, next);
    }

    // setup the azul argument, binding queries and model classes
    var query = req.azul.query;
    var binder = modelBinder(db, req);
    var azulArgs = azulParams.map(function(arg) {
      return arg === 'query' ? query : binder(arg);
    });

    // combine args & bind function we're wrapping
    var combinedArgs = [].concat(expressArgs, azulArgs);
    var bound = fn.apply.bind(fn, this, combinedArgs);

    // add execution to the promise chain. if the bound function returns a
    // promise, then we execute `next` automatically.
    promise = promise.bind(this).then(function() {
      var result = bound();
      return isPromise(result) ? result.then(next) : result;
    });

    return promise.catch(next);
  });
};

module.exports = function(db) {
  var fn = _.partial(route, db);
  fn.route = fn;
  fn.di = fn;
  fn.transaction = transactionMiddleware(db);
  fn.rollback = rollbackMiddleware(db);
  fn.catch = fn.rollback;
  fn.error = fn.rollback;
  return fn;
};
