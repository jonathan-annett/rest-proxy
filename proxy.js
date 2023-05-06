const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
var WebSocketServer = require("websocket").server;
const fs = require('fs');
const { send } = require('process');


function startApp(settings) {

  const app = express();
  app.use(bodyParser.json());

  const listenPort = settings.listen.port || 3000;
  const serverPort = settings.proxy.port  ||  8080;
  const serverHost = settings.proxy.host  || 'localhost';
  const defaultResponse = settings.default;




  const server = http.createServer(app);

  const wsServer =  startWSServer (app,server);
 

  let offline = false;
  let lastOfflineTick = 0;

  let connected_ws_clients = [];
  let text_log_lines = [];
  let json_log_lines = [];


  app.get('/', rootRequestHandler);


  let need_dummy_text = true;
  let need_dummy_json = true;

  if (settings.logging && settings.logging.online) {

      if (settings.logging.online.text) {
        app.get(settings.logging.online.text, (req, res) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain');
          res.end(text_log_lines.join('\n'));
        });
        // the default is log, however to stop pages that rely on /log from breaking
        // and the user has set a non standard url, we need to check for that
        // otherwise, we can just let this handler be the only one.
        need_dummy_text = settings.logging.online.text !== '/log';
      }

      if (settings.logging.online.json) {
        app.get(settings.logging.online.json, (req, res) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(json_log_lines,undefined,4));
        });
        // the default is log.json, however to stop pages that rely on /log.json from breaking
        // and the user has set a non standard url, we need to check for that
        // otherwise, we can just let this handler be the only one.
        need_dummy_json =  settings.logging.online.text !== '/log.json';
      }
  }

  if (need_dummy_text) {
    app.get('/log', (req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end("logging not enabled. see package.json");
    });
  }

  if (need_dummy_json) {
    app.get('/log.json', (req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify("logging not enabled. see package.json"));
    });
  } 

  app.all('*',genericRESTHandler);

  server.listen(listenPort, () => {
    console.log(`Server listening on port ${listenPort}`);
  });

  app.server = server;

  app.close = function () {
    server.close();
  };


  return app;

  function genericRESTHandler(req, res)  {

    const { method, url, headers, body } = req;
    console.log(`${method} ${url}  ${body} received from client`);

    // pass request on to "proxyRequest" which will return a promise
    // that will resolve to the response from the server

    proxyRequest (url, method, headers, body).then(function (responseData) {
      sendResponse(responseData);
      appLog('log','Server response',      responseData );
    }).catch( function (error) { 
      const responseData = getDefaultData ();
      sendResponse(responseData );
      appLog('error','Server unavailable', responseData, error  );
    });

    // whatever happens, we send something back to the client
    // (it's possible responseData is an error response; it's still a response)
    function sendResponse(responseData){

      res.statusCode = responseData.statusCode;
      if (responseData.headers) {
        Object.keys(responseData.headers).forEach((key) => {
          res.setHeader(key, responseData.headers[key]);
        });
      } else {
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(responseData.content || '{}');

    }

  }

  function proxyRequest (uri, method, headers, body) {

    return new Promise((resolve, reject) => {

      
      if (offline && Date.now() - lastOfflineTick > 5000) {
        offline = false;
      }
  
      if (offline) {
        responseData = getDefaultData ();
        return resolve(responseData);
      }

      const responseData = {
        statusCode: 200,
      };

      const req = http.request({ host: serverHost, port: serverPort, path: uri, method, headers }, (res) => {
        const chunks = [];

        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          const json = chunks.join('');
          let payload = null;
          try {
            payload = JSON.parse(json);
          } catch (e) {
            reject(e);
            return;
          }
          resolve(payload);
        });
      });

      req.on('error', (e) => {
        offline = true;
        lastOfflineTick = Date.now();
        reject(e);
      });

      if (method === 'POST' || method === 'PUT') {
        const requestBody = JSON.stringify(body);
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Content-Length', Buffer.byteLength(requestBody));
        req.write(requestBody);
      }
      req.end();
    });


  }

  function getDefaultData () {
    
    const responseData = {
      statusCode : defaultResponse.statusCode || 200
    };

    if (defaultResponse.headers) {
      responseData.headers = {};
      Object.keys(defaultResponse.headers).forEach((key) => {
        responseData.headers[key] = defaultResponse.headers[key];
      });
    } else {
      responseData.headers = {'Content-Type': 'application/json'};
    }
    responseData.content = defaultResponse.content || '{}';
    
    return responseData;
  }
   
  function startWSServer (app,server) {
    const wsServer =  new WebSocketServer({
        httpServer: server,
      });

    const approved_origins = settings.websocket.origins || false; 

  wsServer.on("request", function (request) {

    if (  !approved_origins|| (isArray(approved_origins) && approved_origins.indexOf(request.origin) >= 0) ) {

      var connection = request.accept(null, request.origin);

      if (connected_ws_clients.length > settings.websocket.maxClients) {

        connected_ws_clients.push(connection);
        if (settings.logging.websocket) { 
          
          connection.sendUTF(
            JSON.stringify({
              console:{error: "too many clients"}
            })
          );

          // tell any connected clients that we are full
          // otherwise unless someone is looking at server logs, we don't notice
          // since this is a tool for a developer it's unlikely they will open 100 browsers tabs.
          // but if they do they will all know about it.
          appLog('error','an attempt to connect to the websocket server was rejected because the maximum number of clients was exceeded.');

        }
        connection.close();
        return;

      } else {

        connection.on("message", function (message) {
          if (message.type === "utf8") {
            // process WebSocket message
            try {
              let cmd = JSON.parse(message.utf8Data);

              // the only real command here is a way to manually send a message
              // (ie as if we just proxied it)
              // or to repeat a previous message, which is effectively the same thing

              if (cmd.toProxy) {
                 //  console.log("sending to proxy", cmd.toProxy);

                const { method, url, headers, body } = cmd.toProxy;

                 proxyRequest (url, method, headers, body).then(function (responseData) {
                  
                  appLog('log','Server response',      responseData, null, 'ws' );

               
                }).catch( function (error) { 
            
                  appLog('error','Server unavailable', responseData, error, 'ws'  );
                  
                });

              }

              
            } catch (ie) {
              console.log({ ouch: ie, data: message.utf8Data });
            }
          }
        });

        connection.on("close", function () {
          // close user connection

          connected_ws_clients = connected_ws_clients.filter(
            (c) => c !== connection
          );
          
        });
      }

    } else {
      console.log(
        "rejecting connection:",
        request.origin,
        "not in",
        approved_origins
      );
      request.reject();
    }
  });

  return wsServer;
}
 

  function appLog() {
    if (settings.logging && settings.logging.console) {
      console.log(...arguments);
    }

    if (settings.logging && settings.logging.online) {
      const args = Array.prototype.slice.call(arguments);
      
      const lines = settings.logging.online.lines || 100;

      if (settings.logging.online.text) {
        text_log_lines.push(args.join(' '));
        while (text_log_lines.length > lines) {
          text_log_lines.shift();
        }
      }

      logMethod = args.shift();

      if (settings.logging.online.json) {
        json_log_lines.push({msg:args.join(' '), method:logMethod, time:Date.now()});
        while (json_log_lines.length > lines) {
          json_log_lines.shift();
        }
      }

      if ( settings.logging.online.ws && connected_ws_clients && connected_ws_clients.length > 0) {
        const ws_payload = {console:{}};
        // we send the message as an array so that the client can easily display it

        ws_payload.console[logMethod] = args || [];        
        const json = JSON.stringify(ws_payload);
        connected_ws_clients.forEach((client) => {
          client.sendUTF(json);
        });
      }

    }


 
  }

}

function rootRequestHandler(req,res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html');
  res.end(getRootHtml());
}

function getRootHtml() {

  if (!getRootHtml.cache) {

    const styles_css_path = './style.css';
    const styles_css = fs.existsSync(styles_css_path) ? fs.readFileSync(styles_css_path) : '';
    const browser_src = getFunctionSource(browserCode);

    getRootHtml.cache = `
<html>
<head> 
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy</title>
<style>
${styles_css}
</style>
</head>
<body>

<h1>Proxy</h1>
<input id="uri" placeholder="uri" value="/">
<textarea id="request" placeholder="request"></textarea>
<button id="send">Send</button>
<button id="clear">Clear</button>   
<div id="log"></div>

<script>
${browser_src}
</script>
</body>
</html>
`;
  }
  return getRootHtml.cache;
}

function browserCode(window,navigator,location,document,WebSocket,console,global) {

   console.log('browser code loaded');

   let log_div = document.body.querySelector('#log');

    let send_button = document.body.querySelector('#send');
    let clear_button = document.body.querySelector('#clear');
    let request_textarea = document.body.querySelector('#request');
    let uri_input = document.body.querySelector('#uri');
    

   const real_console = window.console;
    window.console = {
      log: function() {
        const msg = Array.prototype.slice.call(arguments).join(' ');
        log_div.innerHTML += msg+'<br>';
        real_console.log.apply(arguments);
      },
      error: function() { 
        const msg = Array.prototype.slice.call(arguments).join(' ');
        log_div.innerHTML += '<span class="error">'+msg+'</span><br>';
        real_console.error.apply(arguments);    
      },
      warn: function() {
        const msg = Array.prototype.slice.call(arguments).join(' ');
        log_div.innerHTML += '<span class="warn">'+msg+'</span><br>';
        real_console.warn.apply(arguments);    
      },
      info: function() {
        const msg = Array.prototype.slice.call(arguments).join(' ');
        log_div.innerHTML += '<span class="info">'+msg+'</span><br>';
        real_console.info.apply(arguments);    
      }
      
    }



   let ws = new WebSocket( location.orgin.replace(/^http/,'ws') );

    ws.onopen = function() {
      console.log('ws open');
    };

    ws.onmessage = function (evt) {

      const msg = evt.data;
    
      try {
          const payload = JSON.parse(msg);

          if (!!payload && payload.reload) {
            // handle remote reload request from server
            console.log('reloading in 5 seoonds');
            return setTimeout(location.reload.bind(location),5000) ;
          }

          if (!!payload && typeof payload.console === 'object') {
            // display server log messages in browser console
            const keys = Object.keys(payload.console);
            if (keys.length===1) {
              const method = keys[0];
              const fn = window.console[method];
              if (typeof fn === 'function') {
                return fn.apply(window.console,payload.console[method]);
              }
            }

            return console.erorr('invalid console message: '+msg);
          }

          console.info('unknown message: '+msg);

      } catch (e) {
        console.error('ws message error (while parsing): '+e);
      }
 
    }   

    ws.onclose = function() {
      console.log('ws close');
    } 

    ws.onerror = function(err) {
      console.log('ws error: '+err);
    };

    clear_button.addEventListener('click', function() {
      log_div.innerHTML = '';
    });

    send_button.addEventListener('click', function() {

      if (!request_textarea.value.trim()) return alert('no request');

      try {

        const msg = JSON.parse(request_textarea.value);

        if (msg) {
          ws.send({toProxy:msg});
        }

      } catch (e) {

        alert(e.message);

      }
      
    });


}

function getFunctionSource(fn) {
  const fnString = fn.toString();
  const fnSource = fnString.substring(fnString.indexOf('{') + 1, fnString.lastIndexOf('}'));
  return fnSource;
}

// returns a virtual template string

function templateMaker(str) {
  let template = str;
  let template_code = 'return `'+template+'`;'
  let engine = new Function('obj', template_code);

  const self = {};

  Object.defineProperties(self, { 

    template: { 
      get: () => template,
      set: (value) => {
        template = value;
        template_code = 'return `'+template+'`;'
        engine = new Function('obj', template_code);
      } 
    },
    template_code: { 
      get: () => template_code,
      set: (value) => {
        template_code = value;
        template = undefined;
        engine = new Function('obj', template_code);
      }  
    },  

    value: {
      get: () => engine(global),
    },

    render: {
      value: (obj) => engine(obj),
    },


  })

  return self;
}

function getSettings(useDefault) {

  useDefault = useDefault || ! fs.existsSync('./package.json');
  const settings = ( useDefault ? {
    "listen": {
      "port": 3000
    },
    "proxy": {
      "host": "localhost",
      "port": 8080
    },

    "default": {
      "statusCode": 200,
      "headers": {
        "content-type": "application/json"
      },
      "content ": "\"not connected\""
      
    },
    "logging": {
      "console": true,
      "online": {
        "lines": 100,
        "ws": true,
        "text": "/log",
        "json": "/log.json"
      }
    },
    "websocket" : {
      "maxClients" : 100,
      "origins" : false
    },
    "translate": {
      "GET": {
        "/recall": {
          "POST": {
            "uri": "/recall",
            "headers": { "content-type": "application/json" },
            "content": "{\"Preset\":\"Preset-${preset}\"}",
            "urlParseContent": true
          }
        }
      }
    }


  } : require('./package.json').custom_rest_proxy ) || {};

  if (settings.translate && settings.translate.GET) {

    for (let uri in settings.translate.GET) {
      const operation = settings.translate.GET[uri];

      if (operation.POST && operation.POST.content && operation.POST.urlParseContent) {
        const template = templateMaker(operation.POST.content);
        
        operation.getContent = function (req) {
          return template.render(req.query);
        };

      } else {
        if (operation.POST.content) {
          operation.getContent = function (req) {
            return operation.POST.content;
          };
        } else {
          return function (req) {
            return '';
          }
        }
      }
    }
  }

  return Object.freeze(settings);

}


