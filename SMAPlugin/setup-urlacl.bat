@echo off
:: Run once as Administrator to allow SMGo plugin to listen on port 3001
:: without needing admin rights each time.
echo Registering URL ACL for SMGo HTTP server...
netsh http add urlacl url=http://+:3001/ user="%USERDOMAIN%\%USERNAME%"
echo.
echo Done. You can now run the SMGo plugin without admin rights.
pause
