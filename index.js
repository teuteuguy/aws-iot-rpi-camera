// Access to S3
var AWS = require('aws-sdk'); // For S3

// Access to IoT
var awsIot = require('aws-iot-device-sdk');

// Raspberry specific
var fs = require('fs');
var Camera = require('camerapi');
var cam = new Camera();
var os = require('os');
var ifaces = os.networkInterfaces();

// Load config
var config = require('./config.json');
console.log('[SETUP] Loaded config:');
// console.log(config);

console.log('[SETUP] Configuring Camera to local folder:', config.localStorage);
cam.baseFolder(config.localStorage);


var configIoT = {
    "keyPath": config.iotKeyPath,
    "certPath": config.iotCertPath,
    "caPath": config.iotCaPath,
    "clientId": config.iotClientId,
    "region": config.iotRegion,
//    "reconnectPeriod": 5000,
//    "host": config.iotEndpoint
};

var thingState = {
    ip: null,
    tweet: 'Init from ' + config.iotClientId,
    cameraRotation: 0,
    accessKeyId: null,
    secretAccessKey: null
};

console.log('[SETUP] thingShadow state initialized with:', thingState);

console.log('[SETUP] Initializing IoT thingShadow with config:');
console.log(configIoT);

var thingShadow = awsIot.thingShadow(configIoT);

function intervalFunction() {
    console.log('[RUNNING] In the interval function');
    ifaces.wlan0.forEach(function(iface) {
        if (iface.family == 'IPv4') {

            // Get the Raspberry PIs IP so that we can view it, since it is headless.
            thingState.ip = iface.address;

            thingShadow.publish('test/topic', 'hello');

            thingShadow.update(config.iotClientId, {
                state: {
                    reported: thingState
                }
            });
        }
    });

}

var intervalId = null;

thingShadow.on('connect', function(connack) {

    console.log('[EVENT] thingShadow.on(connect) Connection established to AWS IoT');
    console.log(connack);

    console.log('[RUNNING] Registring to thingShadow');
    thingShadow.register(config.iotClientId, {
        persistentSubscribe: true
    });
    console.log('[RUNNING] Subscribing to topic:', config.iotTriggerTopic);
    thingShadow.subscribe(config.iotTriggerTopic);

    console.log('[RUNNING] Setting up interval');
    intervalId = setInterval(intervalFunction, 5000);
});

thingShadow.on('reconnect', function() {
    console.log('[EVENT] thingShadow.on(reconnect) Trying to reconnect to AWS IoT');
    clearInterval(intervalId);
});  

thingShadow.on('close', function() {
    console.log('[EVENT] thingShadow.on(close) Connection closed, unregistring to shadow.');
    clearInterval(intervalId);
    thingShadow.unregister(config.iotClientId);
});

thingShadow.on('error', function(err) {
    console.error('[EVENT] thingShadow.on(error) error:', err);
});

thingShadow.on('status', function(thingName, stat, clientToken, stateObject) {
    console.log('[EVENT] thingShadow.on(status)');
    console.log(thingName);
    console.log(stat);
    console.log(clientToken);
    console.log(stateObject);
});

thingShadow.on('delta', function(thingName, stateObject) {

    console.log('[EVENT] thingShadow.on(delta): ' + thingName + ': ' + JSON.stringify(stateObject));

    if (stateObject.state.tweet) thingState.tweet = stateObject.state.tweet;
    if (stateObject.state.cameraRotation !== undefined) thingState.cameraRotation = stateObject.state.cameraRotation;
    if (stateObject.state.accessKeyId !== undefined) thingState.accessKeyId = stateObject.state.accessKeyId;
    if (stateObject.state.secretAccessKey !== undefined) thingState.secretAccessKey = stateObject.state.secretAccessKey;

    console.log('[RUNNING] Updated thingState:');
    console.log(thingState);

});


thingShadow.on('message', function(topic, payload) {

    console.log('[EVENT] thingShadow.on(message) received on topic', topic, 'with message', payload.toString());

    if (topic == config.iotTriggerTopic) {

        var filename = Date.now() + '.jpg';

        cam.prepare({
            timeout: 10,
            quality: config.cameraQuality || 85,
            width: config.cameraWidth || 800,
            height: config.cameraHeight || 600,
            rotation: thingState.cameraRotation
        }).takePicture(filename, function(file, err) {

            if (!err) {

                console.log('[RUNNING] Tacking picture to', file);

                var fileBuffer = fs.readFileSync(config.localStorage + '/' + filename);

                var key = '';
                if (config.s3BucketFolder && config.s3BucketFolder.length > 0) key += config.s3BucketFolder + '/';
                key += filename;

                var bucket = config.s3Bucket; // if (config.s3BucketFolder && config.s3BucketFolder.length > 0) bucket += '/' + config.s3BucketFolder;       

                var s3Client = new AWS.S3({
                    accessKeyId: thingState.accessKeyId,
                    secretAccessKey: thingState.secretAccessKey
                });

                s3Client.putObject({
                    ACL: 'public-read',
                    Bucket: bucket,
                    Key: key,
                    Body: fileBuffer,
                    ContentType: 'image/jpg'
                }, function(error, response) {
                    if (!error) {
                        console.log('[RUNNING] Upload to S3 finished', arguments);

                        var toPublish = JSON.stringify({
                            filename: key,
                            tweet: thingState.tweet
                        });

                        console.log('[RUNNING] Publishing to', config.iotPublishTopic, toPublish);

                        thingShadow.publish(config.iotPublishTopic, toPublish);

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

