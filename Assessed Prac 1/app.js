const express = require('express');
const responseTime = require('response-time')
const axios = require('axios');
const redis = require('redis');
require('dotenv').config();
const AWS = require('aws-sdk');

// Cloud Services Set-up 
// Create unique bucket name
const bucketName = 'oliver-regan-wikipedia-store';
const s3 = new AWS.S3({ apiVersion: "2006-03-01" });

s3.createBucket({ Bucket: bucketName })
    .promise()
    .then(() => console.log(`Created bucket: ${bucketName}`))
    .catch((err) => {
        // Ignore 409 errors which indicate that the bucket already exists
        if (err.statusCode !== 409) {
            console.log(`Error creating bucket: ${err}`);
        }
    });


const app = express();

// This section will change for Cloud Services 
// Redis setup
const redisClient = redis.createClient();
redisClient.connect()
    .catch((err) => {
        console.log(err);
    });

// Used to display response time in HTTP header
app.use(responseTime());


app.get("/api/search", (req, res) => {
    const query = (() => { try { return req.query.query.trim(); } catch (e) { return res.json({ "Error": true, "Message": "Couldn't find the 'query' parameter" }) } })()

    // Construct the wiki URL and redis key (reduced font size for clarity)
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=parse&format=json&section=0&page=${query}`;
    const redisKey = `wikipedia:${query}`;
    const s3Key = `wikipedia-${query}`;
    redisClient.get(redisKey).then((result) => {
        if (result) {
            // Serve from redis
            const resultJSON = JSON.parse(result);
            res.json(resultJSON);
        } else {
            // No cache result, check S3
            const params = { Bucket: bucketName, Key: s3Key };
            s3.getObject(params)
                .promise()
                .then((result) => {
                    // Serve from S3
                    const resultJSON = JSON.parse(result.Body);
                    res.json(resultJSON);
                    // Store in cache - redis
                    redisClient.setEx(
                        redisKey,
                        3600,
                        JSON.stringify({ source: "Redis Cache", ...resultJSON.parse })
                    );
                })
                .catch((err) => {
                    if (err.statusCode === 404) {
                        // Serve from Wikipedia API and store in S3
                        axios
                            .get(searchUrl)
                            .then((response) => {
                                const responseJSON = response.data;
                                const body = JSON.stringify({
                                    source: "S3 Bucket",
                                    ...responseJSON,
                                });
                                // Put it into S3
                                const objectParams = { Bucket: bucketName, Key: s3Key, Body: body };
                                s3.putObject(objectParams)
                                    .promise()
                                    .then(() => {
                                        console.log(
                                            `Successfully uploaded data to ${bucketName}/${s3Key}`
                                        );

                                        res.json({ source: "Wikipedia API", ...responseJSON });
                                    });
                                // Store in cache - redis
                                redisClient.setEx(
                                    redisKey,
                                    3600,
                                    JSON.stringify({ source: "Redis Cache", ...responseJSON })
                                );
                            })
                            .catch((err) => res.json(err));
                    } else {
                        // Something else went wrong when accessing S3
                        res.json(err);
                    }
                });
            // Serve from Wikipedia and store in redis
            // axios
            //     .get(searchUrl)
            //     .then((response) => {
            //         const responseJSON = response.data;
            //         redisClient.setEx(
            //             redisKey,
            //             3600,
            //             JSON.stringify({ source: "Redis Cache", ...responseJSON })
            //         );

            //         res.json({ source: "Wikipedia API", ...responseJSON });
            //     })
            //     .catch((err) => res.json(err));
        }

    });
});

app.listen(3000, () => {
    console.log('Server listening on port: ', 3000);
});