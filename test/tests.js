'use strict';

var _ = require('lodash');
var chai = require('chai');
var expect = chai.expect;
var sinon = require('sinon'); chai.use(require('sinon-chai'));
var azul = require('azul');

var ae, req, res, next, db, adapter;
var azulExpress = require('../index');
var BPromise = require('bluebird');

var Adapter = azul.Adapter.extend({
  init: function() {
    this._super.apply(this, arguments);
    this._responders = [];
    this.clients = [];
    this.executed = [];
  },
  fail: function(sql) {
    var responder = function(client, sql/*, args*/) {
      throw new Error('Intentional failure for ' + sql);
    };
    responder.regex = new RegExp(sql, 'i');
    this._responders.unshift(responder);
  },
  respond: function(regex, result) {
    var responder = function(/*client, sql, args*/) {
      return { rows: result, fields: [] };
    };
    responder.regex = regex;
    this._responders.unshift(responder);
  },
  _connect: BPromise.method(function() { return { id: ++this.__identity__.cid }; }),
  _disconnect: BPromise.method(function(/*client*/) {}),
  _execute: BPromise.method(function(client, sql, args) {
    return BPromise.delay(1).bind(this).then(function() {
      var responder = _.find(this._responders,
        function(r) { return sql.match(r.regex); });
      var result = responder && responder(client, sql, args);
      this.clients = _.uniq(this.clients.concat([client]));
      this.executed.push(args.length ? [sql, args] : sql);
      return result || { rows: [], fields: [] };
    });
  }),
}, { cid: 0 });

var pspy = function() {
  var resolve;
  var promise = new BPromise(function() { resolve = arguments[0]; });
  resolve.wait = promise;
  return sinon.spy(resolve);
};

var rspy = function(route) {
  return _.extend(sinon.spy(route), {
    toString: route.toString.bind(route)
  });
};

describe('azul-express', function() {
  beforeEach(function() {
    adapter = Adapter.create();
    db = azul.Database.create({ adapter: adapter });
    req = {};
    res = {};
    res.end = res._end = pspy();
    res.write = res._write = pspy();
    res.writeHead = res._writeHead = pspy();
    next = pspy();
    ae = azulExpress(db);
  });

  it('is an alias for route', function() {
    expect(ae).to.equal(ae.route);
  });

  it('defines error as an alias for rollback', function() {
    expect(ae.error).to.equal(ae.rollback);
  });

  it('defines catch as an alias for rollback', function() {
    expect(ae.catch).to.equal(ae.rollback);
  });

  describe('middleware', function() {

    describe('when begun', function() {
      beforeEach(function(done) {
        ae.transaction(req, res, next);
        next.wait.return().then(done, done);
      });

      it('starts the transaction', function() {
        expect(adapter.executed).to.eql(['BEGIN']);
      });

      it('commits on `end`', function(done) {
        res.end();
        res._end.wait.then(function() {
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN', 'COMMIT']);
        })
        .then(done, done);
      });

      it('calls original `end` with proper args', function(done) {
        res.end('arbitrary', 'argument');
        res.end('again');
        expect(res._end).to.not.have.been.called;
        res._end.wait.then(function() {
          res.end(null);
        })
        .then(function() {
          expect(res._end).to.have.been.calledThrice;
          expect(res._end).to.have.been.calledWithExactly('arbitrary', 'argument');
          expect(res._end).to.have.been.calledWithExactly('again');
          expect(res._end).to.have.been.calledWithExactly(null);
        })
        .then(done, done);
      });

      it('commits on `write`', function(done) {
        res.write();
        res._write.wait.then(function() {
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN', 'COMMIT']);
        })
        .then(done, done);
      });

      it('calls original `write` with proper args', function(done) {
        res.write('arbitrary', 'argument');
        res.write('again');
        expect(res._write).to.not.have.been.called;
        res._write.wait.then(function() {
          res.write(null);
        })
        .then(function() {
          expect(res._write).to.have.been.calledThrice;
          expect(res._write).to.have.been.calledWithExactly('arbitrary', 'argument');
          expect(res._write).to.have.been.calledWithExactly('again');
          expect(res._write).to.have.been.calledWithExactly(null);
        })
        .then(done, done);
      });

      it('commits on `writeHead`', function(done) {
        res.writeHead();
        res._writeHead.wait.then(function() {
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN', 'COMMIT']);
        })
        .then(done, done);
      });

      it('calls original `writeHead` with proper args', function(done) {
        res.writeHead('arbitrary', 'argument');
        res.writeHead('again');
        expect(res._writeHead).to.not.have.been.called;
        res._writeHead.wait.then(function() {
          res.writeHead(null);
        })
        .then(function() {
          expect(res._writeHead).to.have.been.calledThrice;
          expect(res._writeHead).to.have.been.calledWithExactly('arbitrary', 'argument');
          expect(res._writeHead).to.have.been.calledWithExactly('again');
          expect(res._writeHead).to.have.been.calledWithExactly(null);
        })
        .then(done, done);
      });

    });

  });

  describe('rollback middleware', function() {

    it('is always safe to use', function(done) {
      var error = new Error('exepcted');
      ae.rollback(error, req, res, next);
      next.wait.then(function() {
        expect(next.getCall(0).args[0]).to.equal(error);
        expect(adapter.executed).to.eql([]);
      }).then(done, done);
    });

    describe('with transaction middleware enabled', function() {
      beforeEach(function(done) {
        var setup = pspy();
        ae.transaction(req, res, setup); // setup middleware
        setup.wait.return().then(done, done);
      });

      it('performs rollback', function(done) {
        var error = new Error('exepcted');
        ae.rollback(error, req, res, next);
        next.wait.then(function() {
          expect(next.getCall(0).args[0]).to.equal(error);
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN', 'ROLLBACK']);
        }).then(done, done);
      });
    });

  });

  var articleRoute = function(req, res, query, Article) {
    query.select('comments').then(function() {
      return Article.objects.fetch();
    })
    .then(function() {
      res.end();
    });
  };

  var articleErrorRoute = function(err, req, res, next, query, Article) {
    Article; // use all params (jshint)
    res.end();
  };

  describe('wrapped route', function() {

    it('recognizes a next parameter', function() {
      var route = ae.route(function(req, res, next) { next(); });
      expect(route.length).to.eql(3);
    });

    it('recognizes an error parameter', function() {
      var route = ae.route(function(err, req, res, next) {
        /* jshint unused: false */
      });
      expect(route.length).to.eql(4);
    });

    it('recognizes an error parameter with function body', function() {
      var route = ae.route(function(err, req, res, next) { next(); });
      expect(route.length).to.eql(4);
    });

    it('accepts unknown parameter configurations as standard express params', function() {
      var route = ae.route(function(err, req, res, next, bad) {
        /* jshint unused: false */
      });
      expect(route.length).to.eql(3);
    });

    it('throws for unkown params following azul params', function() {
      expect(function() {
        ae.route(function(err, req, res, query, Item, bad) {
          /* jshint unused: false */
        });
      }).to.throw(/unexpected arguments:.*query, item, bad/i);
    });

    it('throws when function cannot be parsed', function() {
      var route = _.extend(function() {}, {
        toString: function() { return 'unstringable'; },
      });
      expect(function() {
        ae.route(route);
      }).to.throw(/cannot create route.*function.*unstringable/i);
    });


    describe('with azul params', function() {
      beforeEach(function() {
        this.route = ae.route(function(req, res, next, query, Article) {
          /* jshint unused: false */
        });
      });

      it('generates a standard express route', function() {
        expect(this.route.length).to.eql(3);
      });
    });

    it('allows execution of sql', function(done) {
      var spy = rspy(articleRoute);
      var route = ae.route(spy);

      route(req, res, next).then(function() {
        var query = spy.getCall(0).args.slice(-2)[0];
        var Article = spy.getCall(0).args.slice(-2)[1];
        expect(query).to.eql(req.azul.query);
        expect(query).to.eql(db.query);
        expect(Article.query).to.eql(req.azul.query);
        expect(Article).to.equal(db.model('article'));
        expect(adapter.executed).to.eql([]);
        return res._end.wait;
      })
      .then(function() {
        expect(adapter.executed).to.eql([
          'SELECT * FROM "comments"',
          'SELECT * FROM "articles"',
        ]);
      })
      .then(done, done);
    });

    it('accepts promises as a return values', function(done) {
      var promise = BPromise.delay(5);
      var route = ae.route(function() { return promise; });

      route(req, res, next)
      .then(function() {
        expect(promise.isResolved()).to.eql(true);
        expect(next).to.not.have.been.called;
      })
      .then(done, done);
    });

    it('allows wrapping', function(done) {
      var wrapper;
      var wrap = sinon.spy(function(fn) {
        wrapper = sinon.spy(function() {
          return fn.apply(this, arguments);
        });
        return wrapper;
      });

      var emptyRoute = rspy(articleRoute);
      var route = ae.route(emptyRoute, { wrap: wrap });

      route(req, res, next)
      .then(function() {
        expect(emptyRoute).to.have.been.calledOnce;
        expect(emptyRoute).to.have.been.calledWithExactly(req, res, db.query, db.model('article'));
        expect(wrapper).to.have.been.calledOnce;
        expect(wrapper).to.have.been.calledWithExactly(req, res, db.query, db.model('article'));
        expect(wrap).to.have.been.calledOnce;
        expect(wrap).to.have.been.calledWithExactly(emptyRoute);
      })
      .then(done, done);
    });

    it('can call next', function(done) {
      var route = ae.route(function(req, res, next, query) {
        query; // use all params (jshint)
        next();
      });

      route(req, res, next).then(function() {
        return next.wait;
      })
      .then(function() {
        expect(next).to.have.been.calledOnce;
        expect(next).to.have.been.calledWithExactly();
      })
      .then(done, done);
    });

    describe('with transaction middleware enabled', function() {
      beforeEach(function(done) {
        var setup = pspy();
        ae.transaction(req, res, setup); // setup middleware
        setup.wait.return().then(done, done);
      });

      it('executes sql in transaction', function(done) {
        var spy = rspy(articleRoute);
        var route = ae.route(spy);

        route(req, res, next).then(function() {
          var query = spy.getCall(0).args.slice(-2)[0];
          var Article = spy.getCall(0).args.slice(-2)[1];
          expect(query).to.eql(req.azul.query);
          expect(query.transaction()).to.eql(req.azul.transaction);
          expect(Article.query).to.eql(req.azul.query);
          expect(adapter.executed).to.eql(['BEGIN']);
          return res._end.wait;
        })
        .then(function() {
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql([
            'BEGIN',
            'SELECT * FROM "comments"',
            'SELECT * FROM "articles"',
            'COMMIT'
          ]);
        })
        .then(done, done);
      });
    });

  });

  describe('wrapped route w/ transaction', function() {

    it('allows execution of sql', function(done) {
      var spy = rspy(articleRoute);
      var route = ae.route(spy, { transaction: true });

      route(req, res, next).then(function() {
        var query = spy.getCall(0).args.slice(-2)[0];
        var Article = spy.getCall(0).args.slice(-2)[1];
        expect(query).to.eql(req.azul.query);
        expect(query.transaction()).to.eql(req.azul.transaction);
        expect(Article.query).to.eql(req.azul.query);
        expect(adapter.executed).to.eql(['BEGIN']);
        return res._end.wait;
      })
      .then(function() {
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql([
          'BEGIN',
          'SELECT * FROM "comments"',
          'SELECT * FROM "articles"',
          'COMMIT'
        ]);
      })
      .then(done, done);
    });

    it('works for defining error middleware', function(done) {
      var spy = rspy(articleErrorRoute);
      var route = ae.route(spy, { transaction: true });

      route(new Error('Error'), req, res, next).then(function() {
        var query = spy.getCall(0).args.slice(-2)[0];
        var Article = spy.getCall(0).args.slice(-2)[1];
        expect(query).to.eql(req.azul.query);
        expect(query.transaction()).to.eql(req.azul.transaction);
        expect(Article.query).to.eql(req.azul.query);
        expect(adapter.executed).to.eql(['BEGIN']);
        return res._end.wait;
      })
      .then(function() {
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql(['BEGIN', 'COMMIT']);
      })
      .then(done, done);
    });

    it('performs rollback if next is called with error', function(done) {
      var error = new Error('Expected');
      var route = ae.route(function(req, res, next, query) {
        query; // use all params (jshint)
        next(error);
      }, { transaction: true });

      route(req, res, next).then(function() {
        expect(adapter.executed).to.eql(['BEGIN']);
        return next.wait;
      })
      .then(function() {
        expect(next).to.have.been.calledOnce;
        expect(next).to.have.been.calledWithExactly(new Error('Expected'));
        expect(next.getCall(0).args[0]).to.equal(error);
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql(['BEGIN', 'ROLLBACK']);
      })
      .then(done, done);
    });

    it('performs rollback if returned promise is rejected', function(done) {
      var error = new Error('Expected');
      var route = ae.route(function(req, res, next, query) {
        query; // use all params (jshint)
        return BPromise.reject(error);
      }, { transaction: true });

      route(req, res, next).then(function() {
        return next.wait;
      })
      .then(function() {
        expect(next).to.have.been.calledOnce;
        expect(next).to.have.been.calledWithExactly(new Error('Expected'));
        expect(next.getCall(0).args[0]).to.equal(error);
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql(['BEGIN', 'ROLLBACK']);
      })
      .then(done, done);
    });

    it('performs only one rollback if rolled back manually & through error', function(done) {
      var route = ae.route(function(req, res, next, query) {
        query; // use all params (jshint)
        res.azul.rollback();
        next(new Error('Expected'));
      }, { transaction: true });

      route(req, res, next).then(function() {
        return next.wait;
      })
      .then(function() {
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql(['BEGIN', 'ROLLBACK']);
      })
      .then(done, done);
    });

    it('passes on calls to next without arguments', function(done) {
      var route = ae.route(function(req, res, next, query) {
        query; // use all params (jshint)
        next();
      }, { transaction: true });

      route(req, res, next).then(function() {
        expect(adapter.executed).to.eql(['BEGIN']);
        return next.wait;
      })
      .then(function() {
        expect(next).to.have.been.calledOnce;
        expect(next).to.have.been.calledWithExactly();
        expect(adapter.clients.length).to.eql(1);
        // commit would occur on write from future middleware
        expect(adapter.executed).to.eql(['BEGIN']);
      })
      .then(done, done);
    });

    it('passes on calls to next with non-error', function(done) {
      var route = ae.route(function(req, res, next, query) {
        query; // use all params (jshint)
        next('value');
      }, { transaction: true });

      route(req, res, next).then(function() {
        return next.wait;
      })
      .then(function() {
        expect(next).to.have.been.calledOnce;
        expect(next).to.have.been.calledWithExactly('value');
        expect(adapter.clients.length).to.eql(1);
        // commit would occur on write from future middleware
        expect(adapter.executed).to.eql(['BEGIN']);
      })
      .then(done, done);
    });

    describe('when begin transaction fails', function() {
      beforeEach(function() {
        adapter.fail('BEGIN');
      });

      it('calls next with error', function(done) {
        var route = ae.route(function(req, res, query, Article) {
          /* jshint unused: false */
        }, { transaction: true });

        route(req, res, next).then(function() {
          return next.wait;
        })
        .then(function() {
          expect(next).to.have.been.calledOnce;
          expect(next.getCall(0).args[0]).to.match(/intentional failure for begin/i);
          expect(adapter.clients.length).to.eql(0);
          expect(adapter.executed).to.eql([]);
        })
        .then(done, done);
      });
    });

    describe('when commit transaction fails', function() {
      beforeEach(function() {
        adapter.fail('COMMIT');
      });

      it('calls next with error', function(done) {
        var route = ae.route(function(req, res, query, Article) {
          Article; // use all params (jshint)
          res.end();
        }, { transaction: true });

        route(req, res, next).then(function() {
          return res.azul.commit();
        })
        .then(function() {
          return next.wait;
        })
        .then(function() {
          expect(next).to.have.been.calledOnce;
          expect(next.getCall(0).args[0]).to.match(/intentional failure for commit/i);
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN']);
        })
        .then(done, done);
      });

    });

    describe('when rollback transaction fails', function() {
      beforeEach(function() {
        adapter.fail('ROLLBACK');
      });

      it('calls next with error', function(done) {
        var route = ae.route(function(req, res, query, Article) {
          Article; // use all params (jshint)
          res.azul.rollback();
        }, { transaction: true });

        route(req, res, next).then(function() {
          return res.azul.rollback();
        })
        .then(function() {
          return next.wait;
        })
        .then(function() {
          expect(next).to.have.been.calledOnce;
          expect(next.getCall(0).args[0]).to.match(/intentional failure for rollback/i);
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN']);
        })
        .then(done, done);
      });

    });

    it('works with relationships', function(done) {
      db.model('article').reopen({
        author: db.belongsTo(),
        comments: db.hasMany(),
      });
      db.model('author', { articles: db.hasMany(), });
      db.model('comment', { article: db.belongsTo() });
      adapter.respond(/select \* from "authors"/i, [{ id: 5 }]);
      adapter.respond(/select \* from "articles"/i,
        [{ id: 1, 'author_id': 5 }]);

      var route = ae.route(function(req, res, query, Article) {
        Article.objects.find(1).tap(function(article) {
          return article.fetchAuthor();
        })
        .tap(function(article) {
          return article.commentObjects.fetch();
        })
        .then(function() {
          res.end();
        })
        .catch(done);
      }, { transaction: true });

      route(req, res, next).then(function() {
        expect(adapter.executed).to.eql(['BEGIN']);
        return res._end.wait;
      })
      .then(function() {
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql([
          'BEGIN',
          ['SELECT * FROM "articles" WHERE "id" = ? LIMIT 1', [1]],
          ['SELECT * FROM "authors" WHERE "id" = ? LIMIT 1', [5]],
          ['SELECT * FROM "comments" WHERE "article_id" = ?', [1]],
          'COMMIT'
        ]);
      })
      .then(done, done);
    });

  });

  describe('test setup', function() {
    it('uses multiple clients', function(done) {
      // open transaction & query must use separate clients
      var txn = db.transaction();
      txn.begin()
      .then(function() { return db.query.select('comments'); })
      .then(function() { return txn.commit(); })
      .then(function() {
        expect(adapter.clients.length).to.eql(2);
      })
      .then(done, done);
    });
  });

});
