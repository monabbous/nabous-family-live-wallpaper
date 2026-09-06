swiftc \
  -O \
  -framework CoreLocation \
  GeoNamesGeocoder.swift \
  Wallserve.swift \
  -o build/Wallserve.app/Contents/MacOS/Wallserve


cp \
  geodata/LY.txt \  
  geodata/admin1CodesASCII.txt \
  geodata/countryInfo.txt \
  build/Wallserve.app/Contents/Resources/geodata/

codesign \
  --force \
  --sign - \
  build/Wallserve.app