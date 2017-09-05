// Load the AWS SDK
var AWS = require('aws-sdk'); // For S3

// Load the AWS IoT Javascript SDK
var awsIot = require('aws-iot-device-sdk');

// Raspberry specific
var fs = require('fs');
var Camera = require('camerapi');
var cam = new Camera();

// Load config file
var config = require('./config.json');
console.log('[SETUP] Loaded config:');
console.log(JSON.stringify(config, null, 2));

// Helper functions
function publishError(errorObject) {
    if (errorObject) {
        console.error('[ERROR] publishError:', errorObject);
        if (thingState.iotErrorTopic !== null && thingState.iotErrorTopic !== '') thingShadow.publish(thingState.iotErrorTopic, JSON.stringify(errorObject));
    }
}

function publishActivity(message) {
    if (message) {
        if (thingState.iotActivityTopic !== null && thingState.iotActivityTopic !== '') thingShadow.publish(thingState.iotActivityTopic, JSON.stringify({
            activity: message
        }));
    }
}

function eventTopic() {
    return 'rpi-camera/' + config.iotThingName + '/event';
}


function takePicture(filename) {
    return new Promise((resolve, reject) => {
        console.log('[EVENT] takePicture: Taking picture');

        cam.prepare({
            timeout: 1, //10,
            quality: thingState.cameraQuality || 85,
            width: thingState.cameraWidth || 800,
            height: thingState.cameraHeight || 600,
            rotation: thingState.cameraRotation || 0
        }).takePicture(filename, (file, err) => {

            if (err) {
                console.error('[ERROR] takePicture: there was an error when trying to take the picture');
                reject(err);
            } else {
                resolve(file);
            }

        });
    });

}

function getCognitoCredentials() {
    return new Promise((resolve, reject) => {

        console.log('[EVENT] getCognitoCredentials: Getting credentials via Cognito');

        if (!thingState.cognitoIdentityPoolId || !thingState.cognitoRegion) {
            console.error('[ERROR] No CognitoIdentityPoolId or CognitoRegion provided in the state');
            reject({
                error: 'No CognitoIdentityPoolId or CognitoRegion provided in the state'
            });
        } else {

            // Initialize the Amazon Cognito credentials provider
            AWS.config.region = thingState.cognitoRegion; // Region
            AWS.config.credentials = new AWS.CognitoIdentityCredentials({
                IdentityPoolId: thingState.cognitoIdentityPoolId,
            });

            AWS.config.credentials.get((err) => {

                if (err) {
                    console.error('[ERROR] there was an error when trying to authenticate with Cognito');
                    reject(err);
                } else {
                    resolve({
                        accessKeyId: AWS.config.credentials.accessKeyId,
                        secretAccessKey: AWS.config.credentials.secretAccessKey
                    });
                }

            });

        }
    });

}


function uploadToS3(bucket, key, filename) {

    return new Promise((resolve, reject) => {

        console.log('[EVENT] uploadToS3: Uploading to S3 bucket: ' + bucket + ' with key: ' + key + ' with filename: ' + filename);

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
        }, (err, response) => {

            if (err) {
                console.error('[ERROR] uploadToS3: there was an error when uploading picture to S3');
                console.error(JSON.stringify(err, null, 2));
                reject(err);
            } else {
                console.log('[EVENT] uploadToS3: Upload to S3 finished', response);
                console.log('[EVENT] uploadToS3: Deleting local file');
                // Lets delete the file, now that it's been uploaded.
                fs.unlinkSync(filename);

                resolve(key);
            }

        });

    });

}



// Start of the Application
console.log('[SETUP] Configuring Camera to local folder:', config.localStorage);
cam.baseFolder(config.localStorage);

var configIoT = {
    keyPath: config.iotKeyPath,
    certPath: config.iotCertPath,
    caPath: config.iotCaPath,
    clientId: config.iotClientId,
    region: config.iotRegion,
    reconnectPeriod: 5000,
    host: config.iotEndpoint,
    will: {
        topic: config.iotThingName + '/lwt',
        payload: JSON.stringify({
            state: {
                reported: {
                    connected: false
                }
            }
        }),
        qos: 0,
        retain: false
    }
};

var thingState = {
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

thingShadow.on('connect', () => {
    console.log('[EVENT] thingShadow.on(connect): Connection established to AWS IoT');
    console.log('[EVENT] thingShadow.on(connect): Registring to thingShadow');

    thingShadow.register(config.iotThingName, {
        persistentSubscribe: true
    }, () => {
        thingShadow.update(config.iotThingName, {
            state: {
                reported: {
                    'rpi-camera': thingState,
                    connected: true
                }
            }
        });

        thingShadow.subscribe(eventTopic(), {
            qos: 1
        }, (err, granted) => {
            if (err) publishError(err);
            else {
                console.log('[EVENT] thingShadow.on(connect): Subscribed to topic:', 'rpi-camera/' + config.iotThingName + '/event');
            }
        });
    });

});

thingShadow.on('reconnect', function() {
    console.log('[EVENT] thingShadow.on(reconnect) Trying to reconnect to AWS IoT');
});

thingShadow.on('close', function() {
    console.log('[EVENT] thingShadow.on(close) Connection closed, unregistring to shadow.');
    thingShadow.unregister(config.iotThingName);
});

thingShadow.on('error', function(err) {
    console.error('[EVENT] thingShadow.on(error) error:', err);
    // process.exit();
    throw new Error('[ERROR] Lets crash the node code because of this error.');
});

thingShadow.on('status', function(thingName, stat, clientToken, stateObject) {
    // console.log('[EVENT] thingShadow.on(status): thingName:', thingName);
    // console.log('[EVENT] thingShadow.on(status): stat:', stat);
    // console.log('[EVENT] thingShadow.on(status): clientToken:', clientToken);
    // console.log('[EVENT] thingShadow.on(status): stateObject:', JSON.stringify(stateObject, null, 2));
});

thingShadow.on('delta', function(thingName, stateObject) {

    console.log('[EVENT] thingShadow.on(delta): ' + thingName + ': ' + JSON.stringify(stateObject.state));

    for (var propertyName in stateObject.state['rpi-camera']) {
        console.log('[EVENT] thingShadow.on(delta): ' + propertyName + ': ' + JSON.stringify(stateObject.state['rpi-camera'][propertyName]));

        if (propertyName === 'iotTriggerTopic') {
            console.log('[EVENT] thingShadow.on(delta): Subscribing to topic:', stateObject.state['rpi-camera'][propertyName]);
            if (thingState.iotTriggerTopic !== null) {
                console.log('[EVENT] thingShadow.on(delta): Need to unsubscribe to old topic:', thingState.iotTriggerTopic);
                thingShadow.unsubscribe(thingState.iotTriggerTopic, publishError);
            }

            thingShadow.subscribe(stateObject.state['rpi-camera'][propertyName], {
                qos: 1
            }, (err, granted) => {
                if (err) publishError(err);
                else {
                    console.log('[EVENT] thingShadow.on(delta): Subscribed to topic:', stateObject.state['rpi-camera'][propertyName]);
                }
            });
        }

        thingState[propertyName] = stateObject.state['rpi-camera'][propertyName];
        console.log('[EVENT] thingShadow.on(delta): ' + propertyName + ': ' + JSON.stringify(stateObject.state['rpi-camera'][propertyName]) + ' => ' + thingState[propertyName]);
    }

    thingShadow.update(config.iotThingName, {
        state: {
            reported: {
                'rpi-camera': thingState,
                connected: true
            }
        }
    });

});


thingShadow.on('message', function(topic, payload) {

    console.log('[EVENT] thingShadow.on(message): received on topic', topic, 'with message', payload.toString());

    if (topic === eventTopic()) {
        console.log('[EVENT] thingShadow.on(message): received an event:', payload.event);
        
        if (payload.event === 'kill') {
            console.log('[EVENT] thingShadow.on(message): kill');
            process.exit();
        }

    } else if (!(
            topic === thingState.iotTriggerTopic && (
                (thingState.s3Bucket !== null && thingState.s3Bucket !== '') ||
                (thingState.s3BucketRegion !== null && thingState.s3BucketRegion !== '') ||
                (thingState.cognitoRegion !== null && thingState.cognitoRegion !== '') ||
                (thingState.cognitoIdentityPoolId !== null && thingState.cognitoIdentityPoolId !== '')
            )
        )) {
        console.log('[EVENT] thingShadow.on(message): not doing anything because there is no S3 specified');
    } else {

        publishActivity('Taking picture');

        var filename = Date.now() + '.jpg';
        var key = thingState.s3BucketFolder + '/' + config.iotThingName + '/' + filename;
        var bucket = thingState.s3Bucket;

        Promise.all([
            takePicture(filename),
            getCognitoCredentials()
        ]).then((responses) => {
            console.log(responses);
            console.log('[EVENT] thingShadow.on(message): Took picture', responses[0]);
            console.log('[EVENT] thingShadow.on(message): And got Cognito credentials');
            console.log('[EVENT] thingShadow.on(message): Access Key Id:', AWS.config.credentials.accessKeyId);
            console.log('[EVENT] thingShadow.on(message): Secret Access Key:', AWS.config.credentials.secretAccessKey);

            var message = 'Uploading file to S3 bucket ' + bucket + 'with key: ' + key;
            console.log('[EVENT] thingShadow.on(message): ' + message);
            publishActivity(message);

            return uploadToS3(bucket, key, config.localStorage + '/' + filename);

        }).then((key) => {

            publishActivity('Upload to S3 completed:', key);

            if (thingState.iotUploadedTopic !== undefined && thingState.iotUploadedTopic !== '') {
                var toPublish = {
                    filename: key
                };
                console.log('[EVENT] thingShadow.on(message): Publishing to', thingState.iotUploadedTopic, JSON.stringify(toPublish, null, 2));
                thingShadow.publish(thingState.iotUploadedTopic, JSON.stringify(toPublish), {
                    qos: 1
                }, () => {
                    console.log('[EVENT] thingShadow.on(message): Published', thingState.iotUploadedTopic);
                });
            }

        }).catch((err) => {
            console.error('[ERROR] thingShadow.on(message): error: ', err);
            publishError(err);
        });

    }

});