var aws = require('aws-sdk'); // For S3
var awsIot = require('aws-iot-device-sdk'); // For IoT
var fs = require('fs');
var config = require('./config.json');
var Camera = require('camerapi');
var cam = new Camera();

cam.baseFolder(config.localStorage);

console.log('Loaded config:', config);

var configIoT = {
    "keyPath": config.iotKeyPath,
    "certPath": config.iotCertPath,
    "caPath": config.iotCaPath,
    "clientId": config.iotClientId,
    "region": config.iotRegion,
    "reconnectPeriod": 5000,
    "host": config.iotEndpoint
};

var thingShadow = awsIot.thingShadow(configIoT);

var thingState = {
    ip: null,
    tweet: 'Hi from ' + config.iotClientId,
    cameraRotation: 0
};

var os = require('os');
var ifaces = os.networkInterfaces();
setInterval(function() {

    ifaces.wlan0.forEach(function(iface) {

        if (iface.family == 'IPv4') {

            thingState.ip = iface.address;

            thingShadow.update(config.iotClientId, {
		state: {
			reported: thingState
		}
	    }, function() {
		console.log('updated');
	    });

        }
    });

}, 5000);


var s3Client = new aws.S3();

thingShadow.on('connect', function() {
    console.log('Connection established to AWS IoT');
    console.log('Subscribing to topic', config.iotTriggerTopic);
    thingShadow.subscribe('chip/button');
    thingShadow.register(config.iotClientId, {  
      persistentSubscribe: true
    });
});

thingShadow.on('close', function() {
  thingShadow.unregister(config.iotClientId);
});

thingShadow.on('reconnect', function() {
    thingShadow.subscribe('chip/button');
    thingShadow.register(config.iotClientId, {
        persistentSubscribe: true
    });
});  

thingShadow.on('delta', function(thingName, stateObject) {
    // received thingShadow delta on pi-camera: {"timestamp":1461996510,"state":{"tweet":"Hi from pi-camera test"},"metadata":{"tweet":{"timestamp":1461996484}}}
    console.log('received thingShadow delta on ' + thingName+': ' + JSON.stringify(stateObject));

    if (stateObject.state.tweet) thingState.tweet = stateObject.state.tweet;
    if (stateObject.state.cameraRotation) thingState.cameraRotation = stateObject.state.cameraRotation;
});


thingShadow.on('message', function(topic, payload) {

    console.log('Message received on topic', topic, 'with message', payload.toString());

    if (topic == 'chip/button') {

      var filename = Date.now() + '.jpg';

      cam.prepare({
          timeout: 10,
          quality: config.cameraQuality || 85,
          width: config.cameraWidth || 800,
          height: config.cameraHeight || 600,
          rotation: thingState.cameraRotation
      }).takePicture(filename, function(file, err) {

          if (!err) {

              console.log('Tacking picture to', file);

              var fileBuffer = fs.readFileSync(config.localStorage + '/' + filename);

              var key = '';
              if (config.s3BucketFolder && config.s3BucketFolder.length > 0) key += config.s3BucketFolder + '/';
              key += filename;
            
              var bucket = config.s3Bucket;
//              if (config.s3BucketFolder && config.s3BucketFolder.length > 0) bucket += '/' + config.s3BucketFolder;       

              s3Client.putObject({
                  ACL: 'public-read',
                  Bucket: bucket, //config.s3Bucket,
                  Key: key,
                  Body: fileBuffer,
                  ContentType: 'image/jpg'
              }, function(error, response) {
                  if (!error) {
                    console.log('Upload to S3 finished', arguments);
                    console.log('Publishing to', config.iotPublishTopic);
                    thingShadow.publish(config.iotPublishTopic, JSON.stringify({filename: key, tweet: thingState.tweet}));
                  } else {
                    console.error('ERROR', error);
                  }
              });

          } else {
              console.error('ERROR: ', err);
          }

      });

    }

});
