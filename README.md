# Azul.js Addon for Express

[![NPM version][npm-image]][npm-url] [![Build status][travis-image]][travis-url] [![Code Climate][codeclimate-image]][codeclimate-url] [![Coverage Status][coverage-image]][coverage-url] [![Dependencies][david-image]][david-url] [![devDependencies][david-dev-image]][david-dev-url]

This addon simplifies use of Azul.js with Express. For a full overview of this
module, [read the Azul.js Express guide][azul-express].

```js
var azulExpress = require('azul-express')(db);

app.use(azulExpress.transaction);

app.post('/articles', azulExpress.route(function(req, res, next, Article, Author) {
  Author.objects.findOrCreate({ name: req.body.author }).then(function(author) {
    return author.createArticle({ title: req.body.title }).save();
  })
  .then(function(article) {
    res.send({ article: article.json });
  })
  .catch(next);
}));
```

## API

### azulExpress(db)

#### db

Type: `Database`

The database from which to create transactions. The result of this call is an
object that provides the below functions. It is also an alias for the
[`route`](#route) function.

### ae.route(function, [options])

#### function

Type: `Function`

An Express route (or middleware) decorated with Azul.js parameters. For
detailed examples, [read the full guide][azul-express]. This wraps the given
function and returns a new function compatible with Express.

#### options.transaction

Type: `Boolean`

Enable transaction support for this route regardless of whether the
[`transaction`](#transaction) middleware is active.

### ae.transaction

Express middleware for enabling transactions.

### ae.rollback

Express middleware for rolling back transactions. Also aliased as `catch` and
`error`. This is intended for advanced use and only needs to be enabled when
all of the following are true:

 - The [`transaction`](#transaction) middleware is active
 - The route is not wrapped by [`route`](#route)
 - The route calls `next` with an error argument

It does not hurt to enable it all the time, though.

## License

This project is distributed under the MIT license.

[azul]: http://www.azuljs.com/
[azul-express]: http://www.azuljs.com/guides/express/

[travis-image]: http://img.shields.io/travis/wbyoung/azul-express.svg?style=flat
[travis-url]: http://travis-ci.org/wbyoung/azul-express
[npm-image]: http://img.shields.io/npm/v/azul-express.svg?style=flat
[npm-url]: https://npmjs.org/package/azul-express
[codeclimate-image]: http://img.shields.io/codeclimate/github/wbyoung/azul-express.svg?style=flat
[codeclimate-url]: https://codeclimate.com/github/wbyoung/azul-express
[coverage-image]: http://img.shields.io/coveralls/wbyoung/azul-express.svg?style=flat
[coverage-url]: https://coveralls.io/r/wbyoung/azul-express
[david-image]: http://img.shields.io/david/wbyoung/azul-express.svg?style=flat
[david-url]: https://david-dm.org/wbyoung/azul-express
[david-dev-image]: http://img.shields.io/david/dev/wbyoung/azul-express.svg?style=flat
[david-dev-url]: https://david-dm.org/wbyoung/azul-express#info=devDependencies
