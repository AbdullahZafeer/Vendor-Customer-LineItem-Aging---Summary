/*global QUnit*/

sap.ui.define([
	"zfivcaginga/controller/VCAging.controller"
], function (Controller) {
	"use strict";

	QUnit.module("VCAging Controller");

	QUnit.test("I should test the VCAging controller", function (assert) {
		var oAppController = new Controller();
		oAppController.onInit();
		assert.ok(oAppController);
	});

});
