const EventEmitter = require('events');

module.exports = function(stream){
	var listener = new EventEmitter();

  var body = '';

  stream.on('data', function(chunk){
    body += chunk;
  });

  stream.on('end', function(){
    var data = null;
    var err = null;

    try{
      data = JSON.parse(body);
    }catch(e){
      err = e;
    }

		listener.emit('data', 'data', {name: 'data', json: true}, data);
    listener.emit('finish');
	});

  return listener;
};
