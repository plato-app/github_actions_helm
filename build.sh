#!/bin/bash
docker build -f DockerfileBase . -t 463885170232.dkr.ecr.us-west-2.amazonaws.com/github-actions:helm-latest
docker push 463885170232.dkr.ecr.us-west-2.amazonaws.com/github-actions:helm-latest