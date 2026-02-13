# GAS Automated Deployment Script
Write-Host "1. Uploading code to GAS..."
clasp push

Write-Host "2. Updating Web App version..."
# Deployment ID: AKfycbzp_Mdg5MQ4e6JUVW4nIN3eCazr0d5m7Yba3p3OntKeryzCkuXT5MymBaClvOhYygFPaQ
clasp deploy -i AKfycbzp_Mdg5MQ4e6JUVW4nIN3eCazr0d5m7Yba3p3OntKeryzCkuXT5MymBaClvOhYygFPaQ -d "Automated update via deploy.ps1"

Write-Host "Deployment Complete!"
Pause
