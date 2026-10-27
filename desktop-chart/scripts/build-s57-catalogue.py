#!/usr/bin/env python3
"""Builds src/s57/catalogue.json (S-57 object classes, attributes and enumerations) from GDAL's tables.

Usage: python3 scripts/build-s57-catalogue.py <gdal>/ogr/ogrsf_frmts/s57/data
The tables come from GDAL (MIT licence) and follow the IHO S-57 Edition 3.1 object catalogue.
"""
import csv, json, os, sys

src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), '..', 'src', 's57', 'catalogue.json')

def rows(name):
    with open(os.path.join(src, name), newline='', encoding='latin-1') as f:
        return list(csv.DictReader(f))

classes = {}
for r in rows('s57objectclasses.csv'):
    classes[int(r['Code'])] = [r['Acronym'], r['ObjectClass']]
attributes = {}
for r in rows('s57attributes.csv'):
    attributes[int(r['Code'])] = [r['Acronym'], r['Attribute'], r['Attributetype']]
values = {}
for r in rows('s57expectedinput.csv'):
    acr = attributes.get(int(r['Code']), [None])[0]
    if acr:
        values.setdefault(acr, {})[r['ID']] = r['Meaning']

json.dump({'classes': classes, 'attributes': attributes, 'values': values}, open(out, 'w'), separators=(',', ':'))
print(out, len(classes), len(attributes), sum(len(v) for v in values.values()))
