// Load the AWS SDK
var AWS = require('aws-sdk'); // For S3

// Load the AWS IoT Javascript SDK
var awsIot = require('aws-iot-device-sdk');

// Raspberry specific
var Q = require('q');
var fs = require('fs');
var Camera = require('camerapi');
var cam = new Camera();

// Load config file
var config = require('./config.json');
console.log('[SETUP] Loaded config:');
console.log(config);

// Helper functions
var os = require('os');
var ifaces = os.networkInterfaces();

function getIPForInterface(interface) {
    var ip = null;

    ifaces[interface].forEach(function(iface) {
        if (iface.family == 'IPv4') {
            ip = iface.address;
        }
    });

    return ip;
}

function publishError(errorObject) {
    console.error('[ERROR]:', errorObject);
    if (thingState.iotErrorTopic) thingShadow.publish(thingState.iotErrorTopic, JSON.stringify(errorObject));
}

function publishActivity(message) {
    if (thingState.iotActivityTopic) thingShadow.publish(thingState.iotActivityTopic, JSON.stringify({
        activity: message
    }));
}

var clientTokenUpdate;

function refreshShadow() {
    console.log('[REFRESH] Sending current state to AWS IoT');
    // Get the Raspberry PIs IP so that we can view it, since it is headless.
    thingState.ip = getIPForInterface('wlan0');

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

function takePicture(filename) {
    var deferred = Q.defer();

    console.log('[EVENT] takePicture: Taking picture');

    cam.prepare({
        timeout: 1, //10,
        quality: thingState.cameraQuality || 85,
        width: thingState.cameraWidth || 800,
        height: thingState.cameraHeight || 600,
        rotation: thingState.cameraRotation || 0
    }).takePicture(filename, function(file, err) {

        if (err) {
            console.error('[ERROR] there was an error when trying to take the picture');
            deferred.reject(err);
        } else {
            deferred.resolve(file);
        }

    });

    return deferred.promise;
}

function getCognitoCredentials() {
    var deferred = Q.defer();

    console.log('[EVENT] getCognitoCredentials: Getting credentials via Cognito');

    if (!thingState.cognitoIdentityPoolId || !thingState.cognitoRegion) {
        console.error('[ERROR] No CognitoIdentityPoolId or CognitoRegion provided in the state');
        deferred.reject({
            error: 'No CognitoIdentityPoolId or CognitoRegion provided in the state'
        });
    } else {

        // Initialize the Amazon Cognito credentials provider
        AWS.config.region = thingState.cognitoRegion; // Region
        AWS.config.credentials = new AWS.CognitoIdentityCredentials({
            IdentityPoolId: thingState.cognitoIdentityPoolId,
        });

        AWS.config.credentials.get(function(err) {

            if (err) {
                console.error('[ERROR] there was an error when trying to authenticate with Cognito');
                deferred.reject(err);
            } else {
                deferred.resolve({
                    accessKeyId: AWS.config.credentials.accessKeyId,
                    secretAccessKey: AWS.config.credentials.secretAccessKey
                });
            }

        });

    }

    return deferred.promise;
}


function uploadToS3(bucket, key, filename) {

    var deferred = Q.defer();

    var s3Config = {
        region: thingState.s3BucketRegion
    };

    var s3Client = new AWS.S3(s3Config);

    s3Client.putObject({
        ACL: 'public-read',
        Bucket: bucket,
        Key: key,
        Body: fs.readFileSync(filename),
        ContentType: 'image/jpg'
    }, function(err, response) {

        if (err) {
            console.error('[ERROR] there was an error when uploading picture to S3');
            deferred.reject(err);
        } else {
            console.log('[EVENT] uploadToS3: Upload to S3 finished', response);
            console.log('[EVENT] uploadToS3: Deleting local file');
            // Lets delete the file, now that it's been uploaded.
            fs.unlinkSync(filename);

            deferred.resolve(key);
        }

    });

    return deferred.promise;

}



// Start of the Application
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
    cameraRotation: 0,
    cameraQuality: 85,
    cameraWidth: 1920,
    cameraHeight: 1080,
    cognitoRegion: null,
    cognitoIdentityPoolId: null,
    s3Bucket: null,
    s3BucketFolder: null,
    s3BucketRegion: null,
    iotTriggerTopic: null,
    iotErrorTopic: null,
    iotUploadedTopic: null,
    iotActivityTopic: null
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
    // process.exit();
    throw new Error('[ERROR] Lets crash the node code because of this error.');
});

thingShadow.on('status', function(thingName, stat, clientToken, stateObject) {
    console.log('[EVENT] thingShadow.on(status): thingName:', thingName);
    console.log('[EVENT] thingShadow.on(status): stat:', stat);
    console.log('[EVENT] thingShadow.on(status): clientToken:', clientToken);
    console.log('[EVENT] thingShadow.on(status): stateObject:', stateObject);
});

thingShadow.on('delta', function(thingName, stateObject) {

    console.log('[EVENT] thingShadow.on(delta): ' + thingName + ': ' + JSON.stringify(stateObject));

    if (stateObject.state.s3Bucket !== undefined) thingState.s3Bucket = stateObject.state.s3Bucket;
    if (stateObject.state.s3BucketRegion !== undefined) thingState.s3BucketRegion = stateObject.state.s3BucketRegion;
    if (stateObject.state.s3BucketFolder !== undefined) thingState.s3BucketFolder = stateObject.state.s3BucketFolder;

    if (stateObject.state.cameraRotation !== undefined) thingState.cameraRotation = stateObject.state.cameraRotation;
    if (stateObject.state.cameraQuality !== undefined) thingState.cameraQuality = stateObject.state.cameraQuality;
    if (stateObject.state.cameraWidth !== undefined) thingState.cameraWidth = stateObject.state.cameraWidth;
    if (stateObject.state.cameraHeight !== undefined) thingState.cameraHeight = stateObject.state.cameraHeight;

    if (stateObject.state.cognitoIdentityPoolId !== undefined) thingState.cognitoIdentityPoolId = stateObject.state.cognitoIdentityPoolId;
    if (stateObject.state.cognitoRegion !== undefined) thingState.cognitoRegion = stateObject.state.cognitoRegion;

    if (stateObject.state.iotTriggerTopic !== undefined) {
        if (thingState.iotTriggerTopic !== null) thingShadow.unsubscribe(thingState.iotTriggerTopic);
        thingState.iotTriggerTopic = stateObject.state.iotTriggerTopic;
        console.log('[EVENT] thingShadow.on(delta): Subscribing to topic:', thingState.iotTriggerTopic);
        thingShadow.subscribe(thingState.iotTriggerTopic);
    }
    if (stateObject.state.iotErrorTopic !== undefined) thingState.iotErrorTopic = stateObject.state.iotErrorTopic;
    if (stateObject.state.iotUploadedTopic !== undefined) thingState.iotUploadedTopic = stateObject.state.iotUploadedTopic;
    if (stateObject.state.iotActivityTopic !== undefined) thingState.iotActivityTopic = stateObject.state.iotActivityTopic;

    console.log('[EVENT] thingShadow.on(delta): Updated thingState to:');

    console.log(thingState);

    setTimeout(refreshShadow, 1000);
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

        Q.all([
            takePicture(filename),
            getCognitoCredentials()
        ]).spread(function(file, creds) {

        // takePicture(filename).then(function(file) {

            console.log('[EVENT] thingShadow.on(message): Took picture', file);
            console.log('[EVENT] thingShadow.on(message): Getting Cognito credentials');

            // return getCognitoCredentials();
        // }).then(function() {

            console.log('[EVENT] thingShadow.on(message): Access Key Id:', AWS.config.credentials.accessKeyId);
            console.log('[EVENT] thingShadow.on(message): Secret Access Key:', AWS.config.credentials.secretAccessKey);

            console.log('[EVENT] thingShadow.on(message): Tacking picture');

            var key = thingState.s3BucketFolder + '/' + config.iotClientId + '/' + filename;
            var bucket = thingState.s3Bucket;

            console.log('[EVENT] thingShadow.on(message): Upload file to S3');

            publishActivity('Uploading picture to S3 bucket' + bucket + ' with key: ' + key);

            return uploadToS3(bucket, key, config.localStorage + '/' + filename);

        }).then(function(key) {

            publishActivity('Upload to S3 completed');

            if (thingState.iotUploadedTopic) {
                var toPublish = JSON.stringify({
                    filename: key
                });
                console.log('[EVENT] thingShadow.on(message): Publishing to', 'camera/pi-camera/uploaded', toPublish);
                thingShadow.publish(thingState.iotUploadedTopic, toPublish);
            }

        }).catch(function(err) {
            console.error('[ERROR] error:', err);
            publishError(err);
        });

    }

});
