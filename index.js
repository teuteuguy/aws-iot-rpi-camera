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
console.log(config);

console.log('[SETUP] Configuring Camera to local folder:', config.localStorage);
cam.baseFolder(config.localStorage);


var configIoT = {
    "keyPath": config.iotKeyPath,
    "certPath": config.iotCertPath,
    "caPath": config.iotCaPath,
    "clientId": config.iotClientId,
    "region": config.iotRegion,
    "reconnectPeriod": 5000,
    "host": config.iotEndpoint
};

var thingState = {
    ip: null,
    tweet: 'Init from ' + config.iotClientId,
    cameraRotation: 0,
    cameraQuality: 85,
    cameraWidth: 1920,
    cameraHeight: 1080,
    s3Bucket: null,
    s3BucketFolder: null,
    s3BucketRegion: null,
    iotTriggerTopic: null,
    iotErrorTopic: null,
    accessKeyId: null,
    secretAccessKey: null
};

console.log('[SETUP] thingShadow state initialized with:', thingState);

console.log('[SETUP] Initializing IoT thingShadow with config:');
console.log(configIoT);

var thingShadow = awsIot.thingShadow(configIoT);

thingShadow.on('connect', function() {
    console.log('[EVENT] thingShadow.on(connect): Connection established to AWS IoT');

    console.log('[EVENT] thingShadow.on(connect): Registring to thingShadow');
    thingShadow.register(config.iotClientId, {
        persistentSubscribe: true
    });

    setTimeout(refreshShadow, 5000);
});

thingShadow.on('reconnect', function() {
    console.log('[EVENT] thingShadow.on(reconnect) Trying to reconnect to AWS IoT');
});

thingShadow.on('close', function() {
    console.log('[EVENT] thingShadow.on(close) Connection closed, unregistring to shadow.');
    thingShadow.unregister(config.iotClientId);
});

thingShadow.on('error', function(err) {
    console.error('[EVENT] thingShadow.on(error) error:', err);
    process.exit();
});

thingShadow.on('status', function(thingName, stat, clientToken, stateObject) {
    console.log('[EVENT] thingShadow.on(status): thingName:', thingName);
    console.log('[EVENT] thingShadow.on(status): stat:', stat);
    console.log('[EVENT] thingShadow.on(status): clientToken:', clientToken);
    console.log('[EVENT] thingShadow.on(status): stateObject:', stateObject);
});

thingShadow.on('delta', function(thingName, stateObject) {

    console.log('[EVENT] thingShadow.on(delta): ' + thingName + ': ' + JSON.stringify(stateObject));

    if (stateObject.state.tweet) thingState.tweet = stateObject.state.tweet;

    if (stateObject.state.s3Bucket !== undefined) thingState.s3Bucket = stateObject.state.s3Bucket;
    if (stateObject.state.s3BucketRegion !== undefined) thingState.s3BucketRegion = stateObject.state.s3BucketRegion;
    if (stateObject.state.s3BucketFolder !== undefined) thingState.s3BucketFolder = stateObject.state.s3BucketFolder;

    if (stateObject.state.cameraRotation !== undefined) thingState.cameraRotation = stateObject.state.cameraRotation;
    if (stateObject.state.cameraQuality !== undefined) thingState.cameraQuality = stateObject.state.cameraQuality;
    if (stateObject.state.cameraWidth !== undefined) thingState.cameraWidth = stateObject.state.cameraWidth;
    if (stateObject.state.cameraHeight !== undefined) thingState.cameraHeight = stateObject.state.cameraHeight;

    if (stateObject.state.accessKeyId !== undefined) thingState.accessKeyId = stateObject.state.accessKeyId;
    if (stateObject.state.secretAccessKey !== undefined) thingState.secretAccessKey = stateObject.state.secretAccessKey;

    if (stateObject.state.iotTriggerTopic !== undefined) {
        if (thingState.iotTriggerTopic !== null) thingShadow.unsubscribe(thingState.iotTriggerTopic);
        thingState.iotTriggerTopic = stateObject.state.iotTriggerTopic;
        console.log('[EVENT] thingShadow.on(delta): Subscribing to topic:', thingState.iotTriggerTopic);
        thingShadow.subscribe(thingState.iotTriggerTopic);
    }
    if (stateObject.state.iotErrorTopic !== undefined) thingState.iotErrorTopic = stateObject.state.iotErrorTopic;

    console.log('[EVENT] thingShadow.on(delta): Updated thingState to:');
    
    console.log(thingState);

    refreshShadow();
});


thingShadow.on('message', function(topic, payload) {

    console.log('[EVENT] thingShadow.on(message): received on topic', topic, 'with message', payload.toString());

    if (!(
            topic === thingState.iotTriggerTopic && (
                (thingState.s3Bucket !== null && thingState.s3Bucket !== '') ||
                (thingState.s3BucketRegion !== null && thingState.s3BucketRegion !== '')
            )
        )) {
        console.log('[EVENT] thingShadow.on(message): not doing anything because there is no S3 specified');
    } else {

        var filename = Date.now() + '.jpg';

        cam.prepare({
            timeout: 10,
            quality: thingState.cameraQuality || 85,
            width: thingState.cameraWidth || 800,
            height: thingState.cameraHeight || 600,
            rotation: thingState.cameraRotation || 0
        }).takePicture(filename, function(file, err) {

            if (err) {
                return publishError(err);
            } else {

                console.log('[EVENT] thingShadow.on(message): Tacking picture to', file);

                var fileBuffer = fs.readFileSync(config.localStorage + '/' + filename);

                var key = thingState.s3BucketFolder + '/' + filename;
                var bucket = thingState.s3Bucket;

                var s3Config = {
                    region: thingState.s3BucketRegion,
                    accessKeyId: thingState.accessKeyId,
                    secretAccessKey: thingState.secretAccessKey
                };

                var s3Client = new AWS.S3(s3Config);

                console.log('[EVENT] thingShadow.on(message): S3 putObject to', bucket, 'with key', key);

                s3Client.putObject({
                    ACL: 'public-read',
                    Bucket: bucket,
                    Key: key,
                    Body: fileBuffer,
                    ContentType: 'image/jpg'
                }, function(error, response) {
                    if (error) {
                        publishError(error);
                    } else {
                        console.log('[EVENT] thingShadow.on(message): Upload to S3 finished', arguments);

                        // var toPublish = JSON.stringify({
                        //     filename: key,
                        //     tweet: thingState.tweet
                        // });
                        // console.log('[RUNNING] Publishing to', config.iotPublishTopic, toPublish);
                        // thingShadow.publish(config.iotPublishTopic, toPublish);

                    }
                });

            }

        });

    }

});

function publishError(errorObject) {
    console.error('[ERROR]:', errorObject);
    if (thingState.iotErrorTopic) thingShadow.publish(thingState.iotErrorTopic, JSON.stringify(errorObject));
}

var clientTokenUpdate;
function refreshShadow() {
    console.log('[REFRESH] Sending current state to AWS IoT');
    ifaces.wlan0.forEach(function(iface) {
        if (iface.family == 'IPv4') {
            // Get the Raspberry PIs IP so that we can view it, since it is headless.
            thingState.ip = iface.address;
        }
    });
    clientTokenUpdate = thingShadow.update(config.iotClientId, {
        state: {
            reported: thingState
        }
    });
    if (clientTokenUpdate === null) {
        publishError({
            error: 'Update of thingShadow failed, operation still in progress'
        });
    }
}
