var http = require('http');
var fs = require('fs');

var random = require('mass-random');
var ps = require('./decoders/post-sort.js');

var mimeTypes = JSON.parse(fs.readFileSync(__dirname+'/mimeTypes.json'));

class UserSession{
  constructor(ip, app, aimId){
    this.appRef = app;
    var id = aimId || null;

    if (app.sessions.count+1 >= app.sessions.keyPossibilities){
      console.warn('WARN: Too many sesion ids, increasing length');
      app.sessions.keyPossibilities = Math.pow(app.sessions.count, 34);
      app.sessions.keyLength += 1;
    }

    //Get unique ID
    while (id === null || app.sessions.usedIds.indexOf(id) != -1){
      id = random.string(app.sessions.keyLength);
    }

    //Create unique session
    this.ip = ip.toString();
    this.creation = Date.now();
    this.lastActive = Date.now();
    this.id = id;
    app.sessions.usedIds.push(id);

    app.sessions.ids[id] = this;
    app.sessions.count += 1;
    this.timerReset();

    return app.sessions.ids[id];
  }

  timerReset(){
    var appRef = this;
    this.lastActive = Date.now();

    if (this.timer){
      //Delete old timer
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(function(self){
      self.delete();
    }, this.lastActive+this.appRef.sessionExpiry, this);
  }

  delete(){
    this.appRef.deleteSession(this.id);
  }
}

class App{
  constructor(){
    this.bindings = [];
    this.ports = [];


    this.sessions = {
      ids: {},
      keyLength: 20,
      keyPossibilities: Math.pow(34, 20),
      count: 0,
      usedIds: []
    };
    this.noSession = false;
    this.sessionExpiry = 1000*60*60*3; //3h

    this.authenticators = [];
  }

  bind(method, path, callback, requirements){
    if (!(requirements instanceof Object)){
      requirements = {};
    }

    this.bindings.push([method, path, callback, requirements]);
    return this.bindings[this.bindings.length-1];
  }
  get(path, callback, requirements){
    path = path.toLowerCase();
    return this.bind('get', path, callback, requirements);
  }
  post(path, callback, requirements){
    if (!(requirements instanceof Object)){
      requirements = {};
    }
    if (requirements.form === undefined){
      requirements.form = true;
    }

    return this.bind('post', path, callback, requirements);
  }
  put(path, callback, requirements){
    if (!(requirements instanceof Object)){
      requirements = {};
    }
    if (requirements.form === undefined){
      requirements.form = true;
    }

    return this.bind('put', path, callback, requirements);
  }
  delete(path, callback, requirements){
    return this.bind('delete', path, callback, requirements);
  }
  patch(path, callback, requirements){
    if (!(requirements instanceof Object)){
      requirements = {};
    }
    if (requirements.form === undefined){
      requirements.form = true;
    }

    return this.bind('patch', path, callback, requirements);
  }
  addAuth(paths, validityTestor, denied, ignore){
    if (paths.length > 0 && typeof(validityTestor) == "function" && typeof(denied) == "function"){
      this.authenticators.push({paths: paths, validity: validityTestor, ignore: ignore, denied: denied});
    }else{
      //Error
      if (!paths || paths.length <= 0){
        console.error("**ERROR: invalid auth path");
      }
      if (typeof(validityTestor) != "function"){
        console.error("**ERROR: invalid auth validityTestor");
      }
      if (typeof(denied) != "function"){
        console.error("**ERROR: invalid auth denied");
      }
      return false;
    }
  }

  IsValidSession(req, res){
    if (this.noSession){
      return true;
    }

    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;

    if (req.sessionChecked){
      req.sessionChecked = true;
      return req.session !== null;
    }

    if (req.cookies.session instanceof String){
      if (this.sessions.ids[req.cookies.session] instanceof Object && ip === this.sessions.ids[req.cookies.session].ip){
        req.session = this.sessions.ids[req.cookies.session];
        req.session.timerReset();
        req.validSession = true;

        req.sessionChecked = true;

        return true;
      }
    }

    var sid = new UserSession(ip, this, req.cookies.session).id;
    res.setHeader('Set-Cookie', 'session='+sid+';path=/');
    req.cookies.session = sid;
    req.session = this.sessions.ids[sid];

    req.sessionChecked = true;
  }
  IsAuthorized(req, res){
    for (let rule of this.authenticators){
      for (let ignorePath of rule.ingore){
        if (PathTester(ignorePath, req.url)){
          return true;
        }
      }

      for (let restricted of rule.paths){
        if (PathTester(restricted, req.url)){
          if (!rule.validity(req)){
            rule.denied(req, res);
            return false;
          }
        }
      }
    }

    return true;
  }
  deleteSession(id){
    var index = this.sessions.usedIds.indexOf(id);
    this.sessions.usedIds.splice(index, 1);
    this.sessions.ids[id] = undefined;

    this.sessions.count -=1;
  }

  parseFile(req, res, file, includeHeader){
    if (fs.existsSync(file)){
      if (this.headerFile && req.extention === 'html' && !req.query.noHeader){
        res.setHeader('Content-Type', 'text/html');

        res.end(
          MergHTML(
            fs.readFileSync(this.headerFile).toString(),
            fs.readFileSync(file).toString()
          )
        );
        return;
      }else{
        res.setHeader('Chuncked', 'true');
        if (req.extention && mimeTypes[req.extention]){
          res.setHeader('Content-Type', mimeTypes[req.extention]);
        }

        fs.stat(file, function(error, stats){
          var start;
          var end;

          if (req.headers.range){
            var total = stats.size || 0;
            var range = req.headers.range;
            var parts = range.replace(/bytes=/, "").split("-");

            start = parseInt(parts[0], 10);
            end = parts[1] ? parseInt(parts[1], 10) : total-1;
            var chunksize = (end-start)+1;

            if (start > end){
              var c = start;
              start = end;
              end = c;
            }

            res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', chunksize);
          }else{
            res.setHeader('Content-Length', stats.size || 0);
          }

          var stream = fs.createReadStream(file, {start: start, end: end});
          stream.pipe(res);
          req.on('end', stream.close);
          req.on('close', stream.close);
          req.on('error', stream.close);
        });

        return true;
      }
    }
  }
  request(req, res){
    var anchorIndex;
    var queryIndex;
    var index;
    var value;
    var parts;
    var page;
    var name;





    /*--------------------------------------------------------------
        Get Cookies
    --------------------------------------------------------------*/
    req.cookies = {};
    if (req.headers && req.headers.cookie){
      parts = req.headers.cookie.split(';');
      for (let item of parts){
        var sections = item.split('=');
        if (sections.length < 1){
          continue;
        }
        name = sections[0];
        while(name[0] == " "){
          name = name.slice(1);
        }
        sections = sections.splice(1);
        if (sections.length < 1){
          sections = [true];
        }
        req.cookies[name] = sections.join('=');
      }
    }





    /*--------------------------------------------------------------
        Get Querys
    --------------------------------------------------------------*/
    queryIndex = req.url.indexOf('?');
    if (index != -1){
      req.queryString = req.url.substr(queryIndex);
    }else{
      req.queryString = '';
    }

    req.query = {};
    if (queryIndex != -1){
      parts = req.url.slice(queryIndex+1).split('&');
      for (let item of parts){
        item = item.split('=');
        name = item[0];
        value = item.slice(1).join('=');
        if (value === ''){
          value = 'true';
        }

        if (value === 'true'){
          value = true;
        }else if (value === 'false'){
          value = false;
        }

        req.query[name] = value;
      }
    }





    /*--------------------------------------------------------------
        Get Raw Path
    --------------------------------------------------------------*/
    if (queryIndex != -1){
      req.path = req.url.slice(0, queryIndex);
    }else{
      req.path = req.url;
    }





    /*--------------------------------------------------------------
        Get extention
    --------------------------------------------------------------*/
    page = req.path == '/' ? '/index' : req.path;
    page = page.split('.');

    if (page.length>1){
      req.extention = page.splice(-1, 1)[0];
    }else{
      req.extention = null;
    }
    page = page.join('.');





    /*--------------------------------------------------------------
        Get Session
    --------------------------------------------------------------*/
    this.IsValidSession(req, res);






    /*--------------------------------------------------------------
        Get Authorization
    --------------------------------------------------------------*/
    if (!this.IsAuthorized(req, res)){
      return;
    }





    /*--------------------------------------------------------------
        Run URL Handles
    --------------------------------------------------------------*/
    var method = req.method.toLowerCase();

    //bind = [method, path, callback, requirements]
    for (let bind of this.bindings){
      if (bind[0] === method && PathTester(bind[1], req.path)){
        if (bind[3].form){
          sp(req, res);
        }

        bind[2](req, res);
        return true;
      }
    }



    if (this.publicFolder && this.parseFile(req, res, this.publicFolder+page+'.'+req.extention, true)){
      return true;
    }

    this.on404(req, res);
    return false;
  }
  on404(req, res){
    //Error 404
    res.statusCode = 404;
    res.end("Cannot find "+req.url);
  }

  listen(port){
    var appRef = this;
    var id = this.ports.length;
    this.ports[id] = http.Server(function(req, res){
      appRef.request(req, res);
    });
    this.ports[id].listen(port, function(){
      console.info('Listening', port);
    });
    return this.ports[id];
  }
}

function PathTester(path, location){
  path = path.toLowerCase();
  location = location.toLowerCase();

  if (path.indexOf('*') == -1){
    return path === location;
  }else{
    path = path.split('*');
    var index = -1;
    for (let part of path){
      if (part !== ''){
        var partLoc = location.indexOf(part);

        if (index < partLoc){
          index = partLoc;
        }else{
          return false;
        }
      }
    }
    return true;
  }

  return false;
}
function MergHTML(header, other){
  var merg = '';

  var headerOpen = other.indexOf('<head>')+6;
  var headerClose = other.indexOf('</head>');
  if (headerOpen == -1 || headerClose == -1){return other;}
  var otherHead = other.slice(headerOpen, headerClose);

  headerClose = header.indexOf('</head>');
  if (headerClose == -1){return other;}
  merg += header.slice(0, headerClose) + otherHead + '</head><body';



  var bodyOpen = other.indexOf('<body')+5;
  var bodyOpenEnd = other.slice(bodyOpen).indexOf('>')+1;
  var bodyTage = other.slice(bodyOpen, bodyOpen+bodyOpenEnd);
  var otherBody = other.slice(bodyOpen+bodyOpenEnd, other.indexOf('</body>'));
  merg += bodyTage;

  bodyOpen = header.indexOf('<body')+5;
  bodyOpen += header.slice(bodyOpen).indexOf('>')+1;
  merg += header.slice(bodyOpen, header.indexOf('</body>'));

  merg += otherBody + '</body>\n</html>';

  return merg;
}


module.exports = new App();
module.exports.app = App;
module.exports.documentTypes = mimeTypes;